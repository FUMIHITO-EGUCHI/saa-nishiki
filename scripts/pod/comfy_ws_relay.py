# SAA pod-side relay: bridges a ComfyUI instance on localhost to SAA over the SSH
# channel (stdin/stdout), so generated images never touch the pod's disks and never
# transit Runpod's HTTPS proxy edge.
#
# The relay itself is deployed to /dev/shm (RAM) by the SAA main process at session
# start and speaks a line protocol:
#   stdin:  one JSON object per line: {"id": n, "cmd": "ping"|"stats"|"submit"|"interrupt"|"exit", ...}
#   stdout: frames prefixed with @@SAA@@ followed by one JSON object, newline-terminated.
#           Responses carry the request id; unsolicited events carry "event".
# Everything else on stdout (MOTD, echo noise from the forced PTY) is ignored by SAA.
#
# submit: {"id": n, "cmd": "submit", "workflow": {...}, "saveNodes": ["29"]}
#   -> {"id": n, "ok": true, "promptId": "..."}
#   -> events: {"event":"progress","value":..,"max":..}
#              {"event":"preview","data":"<base64 png>"}
#              {"event":"image","node":"29","data":"<base64 png>"}
#              {"event":"done","promptId":"..."} | {"event":"error","message":"..."}
#
# Images are held in memory only; nothing is written under /workspace or any disk.

import base64
import gc
import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
import uuid

def websocket_module():
    """websocket-client, imported on first use.

    Only `submit` needs it. A pod that has not been provisioned yet may not have
    the package, and the setup wizard has to be able to reach `deploy`,
    `provision`, `probe` and `log` on exactly such a pod — so a missing import
    fails that one command instead of the whole relay.
    """
    import websocket  # websocket-client
    return websocket

COMFY_PORT = 8188
for i, arg in enumerate(sys.argv):
    if arg == '--port' and i + 1 < len(sys.argv):
        COMFY_PORT = int(sys.argv[i + 1])

CLIENT_ID = str(uuid.uuid4())
BASE = f'http://127.0.0.1:{COMFY_PORT}'
# Ollama on the pod, loopback only (never exposed through the Runpod proxy)
OLLAMA_BASE = 'http://127.0.0.1:11434'
# loader nodes whose first widget lists the files ComfyUI can see (issue #8)
OBJECT_INFO_NODES = ('CheckpointLoaderSimple', 'LoraLoader', 'VAELoader', 'UpscaleModelLoader',
                     'ControlNetLoader', 'UNETLoader', 'CLIPLoader')
BOOTSTRAP_SCRIPT = '/workspace/saa/bootstrap.sh'
BOOTSTRAP_LOG = '/workspace/saa/logs/bootstrap.log'
PROVISION_SCRIPT = '/workspace/saa/provision.sh'
PROVISION_LOG = '/workspace/saa/logs/provision.log'
WORKSPACE = '/workspace'
COMFY_DIR = '/workspace/runpod-slim/ComfyUI'
MODELS_DIR = '/workspace/models'
# The only files SAA may write on the pod, and the only scripts it may run. A
# deploy names one of these keys; nothing else is writable through the relay.
DEPLOY_TARGETS = {
    'bootstrap.sh': BOOTSTRAP_SCRIPT,
    'provision.sh': PROVISION_SCRIPT,
    'extra_model_paths.yaml': '/workspace/runpod-slim/extra_model_paths.yaml',
}
LOG_FILES = {'bootstrap': BOOTSTRAP_LOG, 'provision': PROVISION_LOG}
# Components provision.sh understands; anything else is rejected before it
# reaches a command line.
PROVISION_COMPONENTS = ('nodes', 'checkpoint', 'fastlora', 'adetailer', 'upscaler', 'controlnet', 'pip')
MODEL_FOLDERS = ('checkpoints', 'loras', 'vae', 'controlnet', 'upscale_models', 'ultralytics/bbox', 'ultralytics/segm', 'sams')


def comfy_down_message(error):
    message = str(error)
    if 'refused' in message.lower():
        return f'ComfyUI is not running on the pod (port {COMFY_PORT} refused): {message}'
    return message
write_lock = threading.Lock()


def emit(obj):
    with write_lock:
        sys.stdout.write('@@SAA@@' + json.dumps(obj, separators=(',', ':')) + '\n')
        sys.stdout.flush()


def get_json(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as response:
        return json.loads(response.read().decode('utf-8'))


def post_json(path, payload):
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(BASE + path, data=data, headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        body = ''
        try:
            body = error.read().decode('utf-8', 'replace')[:1500]
        except Exception:
            pass
        raise RuntimeError(f'{path} HTTP {error.code}: {body}') from error


# ---------------------------------------------------------------- pod setup
# What the setup wizard needs on a pod that has nothing yet: write the three
# durable scripts, run them detached, read their log, and report what is there.
# Only the fixed paths above are ever written or executed.

def service_up(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout):
            return True
    except Exception:  # noqa: BLE001 - down is down, whatever the reason
        return False


def probe_pod():
    """Facts the wizard shows before and after provisioning."""
    try:
        gpu = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader'],
                             capture_output=True, text=True, timeout=15).stdout.strip()
    except Exception:  # noqa: BLE001
        gpu = ''
    try:
        usage = shutil.disk_usage(WORKSPACE)
        workspace_free = usage.free
    except Exception:  # noqa: BLE001
        workspace_free = None

    models = {}
    for folder in MODEL_FOLDERS:
        path = os.path.join(MODELS_DIR, folder)
        try:
            models[folder] = sorted(name for name in os.listdir(path) if not name.startswith('.'))
        except OSError:
            models[folder] = []
    try:
        nodes = sorted(name for name in os.listdir(os.path.join(COMFY_DIR, 'custom_nodes'))
                       if os.path.isdir(os.path.join(COMFY_DIR, 'custom_nodes', name)) and not name.startswith('__'))
    except OSError:
        nodes = []

    return {
        'gpu': gpu,
        'workspaceFree': workspace_free,
        'files': {name: os.path.isfile(path) for name, path in DEPLOY_TARGETS.items()},
        'comfyDir': os.path.isdir(COMFY_DIR),
        'nodes': nodes,
        'models': models,
        'comfyUp': service_up(f'{BASE}/system_stats'),
        'ollamaUp': service_up(f'{OLLAMA_BASE}/api/version'),
    }


def deploy_files(files):
    """Write the wizard's copies of the durable scripts. Returns (written, errors)."""
    written, errors = [], {}
    for entry in files or []:
        name = str(entry.get('name') or '')
        target = DEPLOY_TARGETS.get(name)
        if not target:
            errors[name or '?'] = 'not a deployable file'
            continue
        try:
            payload = base64.b64decode(entry.get('data') or '')
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as handle:
                handle.write(payload)
            if name.endswith('.sh'):
                os.chmod(target, 0o755)
            written.append(name)
        except Exception as error:  # noqa: BLE001
            errors[name] = str(error)
    return written, errors


def run_script(script, log_path, env_extra=None, args=None):
    """Start one of the fixed scripts detached, appending to its log."""
    if not os.path.isfile(script):
        return {'ok': False, 'message': f'script not found: {script} (run the pod setup wizard first)'}
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        env = dict(os.environ)
        env.update(env_extra or {})
        with open(log_path, 'ab') as log:
            subprocess.Popen(['bash', script, *(args or [])], stdout=log, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True, env=env)
        return {'ok': True, 'log': log_path}
    except Exception as error:  # noqa: BLE001
        return {'ok': False, 'message': str(error)}


def read_log(name, offset=0, limit=64 * 1024):
    """Tail a known log from a byte offset so SAA can stream progress."""
    path = LOG_FILES.get(str(name))
    if not path:
        return {'ok': False, 'message': f'unknown log: {name}'}
    try:
        size = os.path.getsize(path)
    except OSError:
        return {'ok': True, 'text': '', 'offset': 0, 'size': 0, 'missing': True}
    start = max(0, min(int(offset or 0), size))
    if size - start > limit:  # a caller that fell behind gets the tail, not a flood
        start = size - limit
    with open(path, 'rb') as handle:
        handle.seek(start)
        chunk = handle.read(limit)
    return {'ok': True, 'text': chunk.decode('utf-8', 'replace'), 'offset': start + len(chunk), 'size': size}


def script_running(script):
    try:
        return subprocess.run(['pgrep', '-f', script], capture_output=True, timeout=10).returncode == 0
    except Exception:  # noqa: BLE001
        return False


class Job:
    def __init__(self, workflow, save_nodes):
        self.workflow = workflow
        self.save_nodes = set(save_nodes or [])
        self.prompt_id = None

    def run(self):
        ws = websocket_module().WebSocket()
        ws.connect(f'ws://127.0.0.1:{COMFY_PORT}/ws?clientId={CLIENT_ID}', timeout=600)
        try:
            queued = post_json('/prompt', {'prompt': self.workflow, 'client_id': CLIENT_ID})
            self.prompt_id = queued.get('prompt_id')
            if not self.prompt_id:
                emit({'event': 'error', 'message': f'no prompt_id in response: {queued}'})
                return
            emit({'event': 'queued', 'promptId': self.prompt_id})

            current_node = None
            images = 0
            while True:
                frame = ws.recv()
                if isinstance(frame, str):
                    message = json.loads(frame)
                    mtype = message.get('type')
                    data = message.get('data') or {}
                    if mtype == 'executing':
                        if data.get('prompt_id') != self.prompt_id:
                            continue
                        current_node = data.get('node')
                        if current_node is None:
                            break  # finished
                    elif mtype == 'progress':
                        emit({'event': 'progress', 'value': data.get('value'), 'max': data.get('max')})
                    elif mtype == 'execution_error':
                        emit({'event': 'error', 'message': json.dumps(data)[:2000]})
                        return
                elif isinstance(frame, (bytes, bytearray)):
                    payload = bytes(frame[8:])  # strip the binary event header
                    if len(payload) < 64:
                        continue
                    encoded = base64.b64encode(payload).decode('ascii')
                    if current_node in self.save_nodes:
                        images += 1
                        emit({'event': 'image', 'node': current_node, 'data': encoded})
                    else:
                        emit({'event': 'preview', 'data': encoded})
                    del payload, encoded
            emit({'event': 'done', 'promptId': self.prompt_id, 'images': images})
        finally:
            try:
                ws.close()
            except Exception:
                pass
            gc.collect()


def handle(request):
    rid = request.get('id')
    cmd = request.get('cmd')
    if cmd == 'ping':
        emit({'id': rid, 'ok': True, 'pong': True, 'clientId': CLIENT_ID})
    elif cmd == 'stats':
        # health/VRAM for the SAA header pill; GET only, nothing touches disks.
        # ok:false here means "relay alive, ComfyUI not answering" (issue #9).
        try:
            emit({'id': rid, 'ok': True, 'stats': get_json('/system_stats')})
        except Exception as error:  # noqa: BLE001
            emit({'id': rid, 'ok': False, 'message': comfy_down_message(error)})
    elif cmd == 'object_info':
        # Model / LoRA / VAE ... names as ComfyUI itself lists them (issue #8):
        # GET /object_info/<node> for a fixed set of loader nodes, one result per
        # node (null + message when a node class is missing or ComfyUI is down).
        nodes = [str(node) for node in (request.get('nodes') or []) if str(node) in OBJECT_INFO_NODES]
        info = {}
        errors = {}
        for node in nodes:
            try:
                info[node] = get_json(f'/object_info/{node}')
            except Exception as error:  # noqa: BLE001
                info[node] = None
                errors[node] = comfy_down_message(error)
        emit({'id': rid, 'ok': True, 'info': info, 'errors': errors})
    elif cmd == 'bootstrap':
        # Re-run the durable restore script after a pod START (Ollama, pip deps,
        # ComfyUI restart). Detached so the relay keeps answering; the log lives
        # on the workspace volume. Only the fixed path is ever executed.
        emit({'id': rid, **run_script(BOOTSTRAP_SCRIPT, BOOTSTRAP_LOG)})
    elif cmd == 'probe':
        # What the setup wizard shows: GPU, free space, which durable files and
        # models are already there, whether ComfyUI and Ollama answer.
        emit({'id': rid, 'ok': True, 'probe': probe_pod(),
              'provisioning': script_running(PROVISION_SCRIPT)})
    elif cmd == 'deploy':
        # SAA's own copies of bootstrap.sh / provision.sh / extra_model_paths.yaml,
        # so a pod that has never been set up needs no manual file transfer.
        written, errors = deploy_files(request.get('files'))
        emit({'id': rid, 'ok': not errors, 'written': written, 'errors': errors})
    elif cmd == 'provision':
        # One-time setup of the durable half (custom nodes, model files). The
        # Civitai token travels in the child's environment, never on a command
        # line, so it stays out of `ps` and out of the log.
        components = [c for c in (request.get('components') or []) if c in PROVISION_COMPONENTS]
        if not components:
            emit({'id': rid, 'ok': False, 'message': 'no known components selected'})
        elif script_running(PROVISION_SCRIPT):
            emit({'id': rid, 'ok': False, 'message': 'provisioning is already running on this pod'})
        else:
            env = {}
            token = str(request.get('civitaiToken') or '')
            if token:
                env['CIVITAI_TOKEN'] = token
            url = str(request.get('civitaiUrl') or '')
            if url.startswith('https://civitai.com/'):
                env['CIVITAI_URL'] = url
            emit({'id': rid, **run_script(PROVISION_SCRIPT, PROVISION_LOG, env,
                                          ['--components', ','.join(components)])})
    elif cmd == 'log':
        # Stream a known log back by byte offset (the wizard's progress pane).
        name = request.get('name')
        result = read_log(name, request.get('offset'))
        script = PROVISION_SCRIPT if name == 'provision' else BOOTSTRAP_SCRIPT
        emit({'id': rid, **result, 'running': script_running(script)})
    elif cmd == 'submit':
        job = Job(request.get('workflow'), request.get('saveNodes'))

        def runner():
            try:
                job.run()
            except Exception as error:  # noqa: BLE001 - report everything to SAA
                message = str(error)
                if 'refused' in message.lower():
                    message = f'ComfyUI is not running on the pod (port {COMFY_PORT} refused): {message}'
                emit({'event': 'error', 'message': message})

        threading.Thread(target=runner, daemon=True).start()
        emit({'id': rid, 'ok': True})
    elif cmd == 'interrupt':
        try:
            post_json('/interrupt', {})
            emit({'id': rid, 'ok': True})
        except Exception as error:  # noqa: BLE001
            emit({'id': rid, 'ok': False, 'message': str(error)})
    elif cmd == 'ollama':
        # One Ollama HTTP call over the relay (chat, tags, ...): the LLM never
        # leaves the pod's loopback and nothing is proxied. Runs on a thread so
        # a long generation does not block ping / stats.
        path = str(request.get('path') or '/api/chat')
        method = str(request.get('method') or 'POST').upper()
        body = request.get('body')
        timeout = float(request.get('timeout') or 300)

        def call():
            if not path.startswith('/api/'):
                emit({'id': rid, 'ok': False, 'message': f'refused path: {path}'})
                return
            try:
                data = json.dumps(body).encode('utf-8') if body is not None and method != 'GET' else None
                req = urllib.request.Request(OLLAMA_BASE + path, data=data, method=method,
                                             headers={'Content-Type': 'application/json'} if data else {})
                with urllib.request.urlopen(req, timeout=timeout) as response:
                    raw = response.read().decode('utf-8')
                    try:
                        payload = json.loads(raw)
                    except ValueError:
                        payload = raw
                    emit({'id': rid, 'ok': True, 'status': response.status, 'json': payload})
            except urllib.error.HTTPError as error:
                detail = ''
                try:
                    detail = error.read().decode('utf-8', 'replace')[:1500]
                except Exception:  # noqa: BLE001
                    pass
                emit({'id': rid, 'ok': False, 'status': error.code, 'message': f'ollama {path} HTTP {error.code}: {detail}'})
            except Exception as error:  # noqa: BLE001
                message = str(error)
                if 'refused' in message.lower():
                    message = f'Ollama is not running on the pod (port 11434 refused): {message}'
                emit({'id': rid, 'ok': False, 'message': message})

        threading.Thread(target=call, daemon=True).start()
    elif cmd == 'exit':
        emit({'id': rid, 'ok': True})
        sys.exit(0)
    else:
        emit({'id': rid, 'ok': False, 'message': f'unknown cmd: {cmd}'})


def main():
    emit({'event': 'ready', 'clientId': CLIENT_ID, 'port': COMFY_PORT})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        try:
            handle(request)
        except SystemExit:
            raise
        except Exception as error:  # noqa: BLE001
            emit({'id': request.get('id'), 'ok': False, 'message': str(error)})


if __name__ == '__main__':
    main()
