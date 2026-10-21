import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { withFakeDom } from './helpers/fakeDom.mjs';

// Keep the viewer and its DOM real; capture callbacks at the editor boundary so
// an old asynchronous edit can finish deterministically after another image opens.
const stubs = {
    './imageEditView.js': `export async function showImageEditor(container, id, guard, refresh, callbacks) {
        globalThis.__libraryViewerTest.callbacks.set(id, callbacks);
    }`,
    './components/myDialog.js': `export async function showDialog(type, options) {
        globalThis.__libraryViewerTest.confirmations.push(options.message);
        return false;
    }`,
    './useSettingsDialog.js': 'export async function openUseSettings() {}',
};
register('data:text/javascript,' + encodeURIComponent(`
    const stubs = ${JSON.stringify(stubs)};
    export async function resolve(specifier, context, next) {
        if (String(context.parentURL ?? '').endsWith('/libraryViewer.js') && specifier in stubs) {
            return { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true };
        }
        return next(specifier, context);
    }
`));
const { createLibraryViewer } = await import('../scripts/renderer/libraryViewer.js');

function project(id, accepted = false) {
    return {
        id, name: `Image ${id}`, currentRevision: accepted ? 'accepted' : 'original',
        revisions: [
            { id: 'original', asset: 'original.png', status: 'original' },
            { id: 'accepted', asset: 'accepted.png', status: 'accepted', parentId: 'original' },
        ],
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function withViewer(body) {
    const state = { callbacks: new Map(), confirmations: [] };
    const api = {
        imageEditGet: async id => project(id),
        workflowImage: async (kind, id, asset) => `image:${id}/${asset}`,
    };
    return withFakeDom(async document => {
        const host = document.createElement('section');
        document.body.append(host);
        const viewer = createLibraryViewer(host, { onBack: async () => {} });
        await body({ ...state, api, host, viewer });
    }, { api, globalSettings: { language: 'en-US' }, __libraryViewerTest: state });
}

function assertShows(host, id) {
    assert.equal(host.querySelector('h3').textContent, `Image ${id}`);
    assert.equal(host.querySelector('.library-viewer-image').src, `image:${id}/original.png`);
}

test('a previous editor revision callback cannot replace the newly opened image', async () => {
    await withViewer(async ({ viewer, host, callbacks }) => {
        await viewer.openProject('A');
        const oldEditor = callbacks.get('A');
        await viewer.openProject('B');

        await oldEditor.onRevisionChange(project('A', true));

        assertShows(host, 'B');
        assert.equal(viewer.busy(), false);
    });
});

test('an old revision image arriving after navigation cannot overwrite the new image', async () => {
    await withViewer(async ({ viewer, host, callbacks, api }) => {
        await viewer.openProject('A');
        const requested = deferred(), response = deferred();
        const getImage = api.workflowImage;
        api.workflowImage = (kind, id, asset) => {
            if (id === 'A' && asset === 'accepted.png') {
                requested.resolve();
                return response.promise;
            }
            return getImage(kind, id, asset);
        };
        const updating = callbacks.get('A').onRevisionChange(project('A', true));
        await requested.promise;
        await viewer.openProject('B');

        response.resolve('image:A/accepted.png');
        await updating;

        assertShows(host, 'B');
        assert.match(host.querySelector('.library-viewer-note').textContent, /^Original image/);
    });
});

test('old busy callbacks neither lock the new editor nor unlock its running job', async () => {
    await withViewer(async ({ viewer, host, callbacks }) => {
        await viewer.openProject('A');
        const oldEditor = callbacks.get('A');
        await viewer.openProject('B');
        const currentEditor = callbacks.get('B');

        oldEditor.onBusyChange(true);
        assert.equal(viewer.busy(), false, 'an old job cannot lock image B');
        currentEditor.onBusyChange(true);
        oldEditor.onBusyChange(false);
        assert.equal(viewer.busy(), true, 'an old completion cannot unlock image B');
        assert.equal(host.querySelector('#library-viewer-back').disabled, true);
        currentEditor.onBusyChange(false);
        assert.equal(viewer.busy(), false);
    });
});

test('old draft callbacks cannot create or clear the new image discard protection', async () => {
    await withViewer(async ({ viewer, host, callbacks, confirmations }) => {
        await viewer.openProject('A');
        const oldEditor = callbacks.get('A');
        await viewer.openProject('B');

        oldEditor.onDraftChange(true);
        assert.equal(await viewer.openProject('C'), true, 'unchanged B needs no discard confirmation');
        assert.equal(confirmations.length, 0);

        callbacks.get('C').onDraftChange(true);
        oldEditor.onDraftChange(false);
        assert.equal(await viewer.openProject('D'), false, 'declining discard keeps the current draft');
        assert.equal(confirmations.length, 1);
        assertShows(host, 'C');
    });
});
