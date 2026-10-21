import { showImageEditor } from './imageEditView.js';
import { showDialog } from './components/myDialog.js';
import { openUseSettings } from './useSettingsDialog.js';
import { element, button, tr } from './workflowUi.js';

// The Library's full-size viewing surface. Edit mode replaces the image with the
// mask canvas here, while the Library window and its selected source stay intact.
export function createLibraryViewer(host, { onBack, onChange = () => {} }) {
    host.classList.add('library-viewer', 'workflow-surface');
    host.hidden = true;
    let source = null, project = null, editing = false, editorReady = false;
    let opening = false, loading = false, working = false, dirty = false;
    let session = 0;
    const bar = element('div', '', 'library-viewer-bar');
    const back = button(tr('一覧に戻る', 'Back to library'), () => guard(async () => {
        if (opening || loading || working) return;
        host.hidden = true;
        await onBack();
    }), 'library-viewer-back');
    const title = element('h3');
    const view = button(tr('画像', 'Image'), () => setMode(false), 'library-viewer-view');
    const edit = button(tr('部分編集', 'Edit area'), () => guard(startEditing), 'library-viewer-edit');
    bar.append(back, title, view, edit);
    const message = element('p', '', 'library-viewer-message');
    message.setAttribute('role', 'status');
    const preview = element('div', '', 'library-viewer-preview');
    const image = element('img', '', 'library-viewer-image');
    const note = element('p', '', 'library-viewer-note');
    const use = button(tr('生成設定を使う…', 'Use settings…'), () => guard(() => openUseSettings({
        ...source.records, image: source.dataUrl, name: source.name, trigger: use,
    })), 'library-viewer-use');
    preview.append(image, note, use);
    const editor = element('section', '', 'library-viewer-editor');
    host.append(bar, message, preview, editor);

    async function guard(action) {
        try { message.textContent = ''; await action(); }
        catch (error) { message.textContent = error.message; }
    }
    function paint() {
        const busy = opening || loading || working;
        back.disabled = view.disabled = edit.disabled = busy;
        host.setAttribute('aria-busy', String(busy));
        view.setAttribute('aria-pressed', String(!editing));
        edit.setAttribute('aria-pressed', String(editing));
        preview.hidden = editing;
        editor.hidden = !editing;
    }
    function setMode(value) {
        if (opening || loading || working) return;
        editing = value;
        paint();
    }
    async function canReplace() {
        if (loading || working) return false;
        if (!dirty) return true;
        return showDialog('confirm', {
            message: tr('未保存のマスク・設定を破棄して別の画像を開きますか？', 'Discard the unsaved masks and settings and open another image?'),
            yesText: tr('別の画像を開く', 'Open another image'), noText: tr('編集を続ける', 'Keep editing'),
        });
    }
    async function revisionChanged(next, mine = session) {
        if (mine !== session) return;
        const current = next.revisions.find(item => item.id === next.currentRevision);
        const src = await globalThis.api.workflowImage('projects', next.id, current.asset);
        if (mine !== session) return;
        project = next; image.src = src;
        note.textContent = current.status === 'original'
            ? tr('元画像。部分編集は別の版として保存します。', 'Original image. Edits are saved as separate revisions.')
            : tr('採用済みの編集結果。元画像は保持されています。', 'Accepted edit. The original image is preserved.');
        await onChange();
    }
    async function startEditing() {
        if (opening || loading || working) return;
        if (editorReady) { setMode(true); return; }
        const mine = session;
        loading = true; paint();
        message.textContent = tr('編集を読み込んでいます…', 'Loading the editor…');
        try {
            project ??= await globalThis.api.imageEditCreate(source.dataUrl, source.name, source.runId, {
                resume: true, sourceKey: source.key,
            });
            editing = true; paint();
            await showImageEditor(editor, project.id, guard, onChange, {
                onBusyChange: value => { if (mine === session) { working = value; paint(); } },
                onDraftChange: value => { if (mine === session) dirty = value; },
                onRevisionChange: next => revisionChanged(next,mine),
            });
            editorReady = true;
            await revisionChanged(project,mine);
            message.textContent = '';
        } finally { loading = false; paint(); }
    }
    function reset(next) {
        ++session;
        source = next; project = null; editorReady = false; dirty = false; editing = false;
        editor.replaceChildren(); title.textContent = next.name; image.src = next.dataUrl;
        image.alt = next.name; message.textContent = '';
        note.textContent = tr('部分編集を選ぶと、この画像上にマスクを描けます。', 'Choose Edit area to paint a mask on this image.');
        use.hidden = !next.records?.recipe && !next.records?.parameters;
        host.hidden = false; paint();
    }
    return {
        active: () => !host.hidden,
        busy: () => opening || loading || working,
        async openImage(input, { edit: editImmediately = false } = {}) {
            if (opening || loading || working) return false;
            opening = true; paint();
            try {
                const next = typeof input === 'function' ? await input() : input;
                if (source?.key !== next.key || source?.dataUrl !== next.dataUrl) {
                    if (!await canReplace()) return false;
                    reset(next);
                } else { host.hidden = false; paint(); }
                opening = false;
                if (editImmediately) await guard(startEditing);
                (editing ? editor.querySelector('#edit-tool') : edit)?.focus();
                return true;
            } finally { opening = false; paint(); }
        },
        async openProject(id) {
            if (opening || loading || working) return false;
            if (project?.id === id && editorReady) { host.hidden = false; setMode(true); return true; }
            opening = true; paint();
            try {
                if (!await canReplace()) return false;
                const next = await globalThis.api.imageEditGet(id);
                const current = next.revisions.find(item => item.id === next.currentRevision);
                const dataUrl = await globalThis.api.workflowImage('projects', id, current.asset);
                reset({key: 'project:'+id, dataUrl, name: next.name});
                project = next; opening = false;
                await guard(startEditing);
                editor.querySelector('#edit-tool')?.focus();
                return true;
            } finally { opening = false; paint(); }
        },
    };
}
