#!/usr/bin/env python3
"""Runs a pre-built batch of ComfyUI API prompts on the Pod and tiles the results.

The Pod has no node runtime, so the graphs are built on the workstation (podjobs.mjs)
and only finished API-format prompts travel over SSH. This script queues them, waits,
pulls the images out of ComfyUI's history, builds one contact sheet per experiment and
prints them back as base64 - the same stdout transport SAA uses for pod images.

    python3 poddriver.py run   --jobs=/tmp/pod-jobs.json --out=/tmp/podout
    python3 poddriver.py sheet --out=/tmp/podout --cell=320
    python3 poddriver.py emit  --file=/tmp/podout/sheet_vocab.jpg

Generated images are deleted from ComfyUI's output folder at the end of `run`: that
folder lives on the Network Volume and nothing here belongs there.
"""

import base64
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HOST = "http://127.0.0.1:8188"


def arg(name, fallback=None):
    for item in sys.argv[1:]:
        if item.startswith("--%s=" % name):
            return item[len(name) + 3:]
    return fallback


def get(path):
    with urllib.request.urlopen(HOST + path) as response:
        return json.load(response)


def post(path, payload):
    request = urllib.request.Request(
        HOST + path,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        return json.load(response)


def run():
    out = arg("out", "/tmp/podout")
    jobs = json.load(open(arg("jobs", "/tmp/pod-jobs.json")))["jobs"]
    client = "saa-pod-%d" % time.time()

    queued = []
    for job in jobs:
        try:
            body = post("/prompt", {"prompt": job["prompt"], "client_id": client})
        except urllib.error.HTTPError as error:
            print("QUEUE FAILED %s: %s" % (job["name"], error.read().decode()[:2000]), flush=True)
            return 1
        queued.append((job["name"], body["prompt_id"]))
    print("queued %d jobs" % len(queued), flush=True)

    started = time.time()
    for index, (name, prompt_id) in enumerate(queued, 1):
        while True:
            history = get("/history/" + prompt_id).get(prompt_id)
            if history:
                break
            time.sleep(3)
        status = (history.get("status") or {}).get("status_str", "?")
        if status == "error":
            print("ERROR %s: %s" % (name, json.dumps(history.get("status"))[:1500]), flush=True)
            continue
        saved = 0
        for node_output in (history.get("outputs") or {}).values():
            for image in node_output.get("images") or []:
                query = urllib.parse.urlencode({
                    "filename": image["filename"],
                    "subfolder": image.get("subfolder", ""),
                    "type": image.get("type", "output"),
                })
                with urllib.request.urlopen(HOST + "/view?" + query) as response:
                    data = response.read()
                subfolder = image.get("subfolder", "").replace("\\", "/")
                if subfolder.startswith("pod/"):
                    subfolder = subfolder[4:]
                folder = os.path.join(out, subfolder)
                os.makedirs(folder, exist_ok=True)
                open(os.path.join(folder, image["filename"]), "wb").write(data)
                saved += 1
        print("[%d/%d] %s %s (%ds)" % (index, len(queued), name, "ok" if saved else "NO IMAGE",
                                       time.time() - started), flush=True)

    # bootstrap.sh points ComfyUI at a /dev/shm output dir, but clear the volume path
    # too in case it was started without that flag. The copies under /tmp are enough.
    for base in ("/dev/shm/comfy_out/pod", "/workspace/runpod-slim/ComfyUI/output/pod"):
        if os.path.isdir(base):
            shutil.rmtree(base, ignore_errors=True)
            print("cleared " + base, flush=True)
    print("done in %ds" % (time.time() - started), flush=True)
    return 0


def sheet():
    from PIL import Image, ImageDraw

    out = arg("out", "/tmp/podout")
    cell = int(arg("cell", "320"))
    label_width = 190
    header = 26
    gap = 4

    for experiment in sorted(os.listdir(out)):
        root = os.path.join(out, experiment)
        if not os.path.isdir(root):
            continue
        rows = []
        for case in sorted(os.listdir(root)):
            files = sorted(f for f in os.listdir(os.path.join(root, case)) if f.endswith(".png"))
            if files:
                rows.append((case, [os.path.join(root, case, f) for f in files]))
        if not rows:
            continue
        columns = max(len(files) for _, files in rows)
        with Image.open(rows[0][1][0]) as probe:
            cell_height = round(cell * probe.height / probe.width)
        width = label_width + columns * (cell + gap)
        height = header + len(rows) * (cell_height + gap)
        sheet_image = Image.new("RGB", (width, height), (24, 24, 28))
        draw = ImageDraw.Draw(sheet_image)
        draw.text((8, 8), "%s  (%d cases)" % (experiment, len(rows)), fill=(235, 235, 235))

        for row, (case, files) in enumerate(rows):
            y = header + row * (cell_height + gap)
            draw.text((8, y + 6), case, fill=(235, 235, 235))
            for column, file_path in enumerate(files):
                with Image.open(file_path) as picture:
                    thumb = picture.convert("RGB").resize((cell, cell_height))
                x = label_width + column * (cell + gap)
                sheet_image.paste(thumb, (x, y))
                draw.text((x + 4, y + 4), os.path.basename(file_path)[:26], fill=(255, 220, 60))

        if sheet_image.width > 1700:
            scale = 1700 / sheet_image.width
            sheet_image = sheet_image.resize((1700, round(sheet_image.height * scale)))
        target = os.path.join(out, "sheet_%s.jpg" % experiment)
        sheet_image.save(target, quality=80, optimize=True)
        print("%s %dx%d %dKB" % (target, sheet_image.width, sheet_image.height,
                                 os.path.getsize(target) // 1024), flush=True)
    return 0


def emit():
    path = arg("file")
    data = base64.b64encode(open(path, "rb").read()).decode()
    print("B64" + "START", os.path.basename(path), len(data), flush=True)
    for index in range(0, len(data), 900):
        print(data[index:index + 900], flush=True)
    print("B64" + "END", flush=True)
    return 0


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "run"
    sys.exit({"run": run, "sheet": sheet, "emit": emit}[command]())
