import { setupTextbox } from './myTextbox.js';
import { setupRadiobox } from './myCheckbox.js';
import { element } from '../dom.js';

const DIALOG_Z_INDEX = 100000;
let blurBackdrop = null;
// the dialogs open now, the top one last: only the top one answers Esc
const openDialogs = [];
// the window hears a key before the document, where the panels under a dialog listen
const keyTarget = () => (typeof globalThis.window?.addEventListener === 'function' ? globalThis.window : document);

function createDialogContainer() {
    const backdrop = element('div', 'dialog-backdrop');
    backdrop.style.zIndex = DIALOG_Z_INDEX;

    const dialog = element('div', 'dialog-container');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.style.zIndex = DIALOG_Z_INDEX + 1;
    backdrop.appendChild(dialog);

    return { backdrop, dialog };
}

function createMessageElement(message) {
    return element('div', 'dialog-message', message);
}

function createButtonContainer(name) {
    return element('div', `dialog-button-container-${name}`);
}

// cancel on the left, the primary button on the right, the row right-aligned (the app-wide order)
function createButtonRow(...names) {
    const row = element('div', 'dialog-button-row');
    row.append(...names.map(createButtonContainer));
    return row;
}

// a footer button of the Dialog component: the primary one (OK, Yes) or the way out (Cancel, No)
function addButton(dialog, name, label, primary, onClick) {
    const button = element('button', primary ? 'selection-modal-apply' : 'selection-modal-cancel', label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    dialog.querySelector(`.dialog-button-container-${name}`).appendChild(button);
    return button;
}

function setBlur() {
    if (blurBackdrop) {
        blurBackdrop.style.display = 'block';
        return;
    }

    blurBackdrop = document.createElement('div');
    blurBackdrop.className = 'blur-backdrop';
    blurBackdrop.style.position = 'fixed';
    document.body.appendChild(blurBackdrop);
}

function setNormal() {
    if (blurBackdrop) {
        blurBackdrop.style.display = 'none';
    }
}

function showDialog(type, options = {}) {
    return new Promise((resolve) => {
        const { backdrop, dialog } = createDialogContainer();
        let result = null;
        // as the other dialogs: Esc takes the way out, closing gives the focus back to where it was
        const opener = document.activeElement;
        let escapeButton = null;
        const onKeyDown = (event) => {
            if (event.key !== 'Escape' || event.isComposing || openDialogs.at(-1) !== dialog) return;
            // the panels and dialogs under this one keep their Esc
            event.preventDefault();
            event.stopPropagation();
            escapeButton?.click();
        };

        const cleanup = () => {
            keyTarget().removeEventListener('keydown', onKeyDown, true);
            openDialogs.splice(openDialogs.indexOf(dialog), 1);
            dialog.remove();
            backdrop.remove();
            document.body.style.overflow = 'auto';
            if (opener?.isConnected) opener.focus?.();
        };

        document.body.style.overflow = 'hidden';
        document.body.appendChild(backdrop);
        openDialogs.push(dialog);
        keyTarget().addEventListener('keydown', onKeyDown, true);

        switch (type) {
            case 'info': {
                const { message = 'Information', buttonText = 'OK' } = options;
                dialog.appendChild(createMessageElement(message));

                dialog.appendChild(createButtonContainer('ok'));
                const ok = addButton(dialog, 'ok', buttonText, true, () => {
                    result = true;
                    cleanup();
                    resolve(result);
                });
                escapeButton = ok;
                ok.focus();
                break;
            }

            case 'input': {
                const { message = 'Please enter:', placeholder = 'Input', defaultValue = '', buttonText = 'OK', cancelText = 'Cancel', showCancel = true } = options;
                dialog.appendChild(createMessageElement(message));

                const inputContainer = document.createElement('div');
                inputContainer.className = `dialog-input`;
                dialog.appendChild(inputContainer);

                const textbox = setupTextbox(
                    inputContainer.className,
                    placeholder,
                    { value: defaultValue, maxLines: 1 },
                    false,
                    (value) => { result = value; }
                );

                dialog.appendChild(createButtonRow(...(showCancel ? ['cancel'] : []), 'ok'));

                addButton(dialog, 'ok', buttonText, true, () => {
                    cleanup();
                    resolve(result || textbox.getValue());
                });
                if(showCancel) {
                    escapeButton = addButton(dialog, 'cancel', cancelText, false, () => {
                        result = null;
                        cleanup();
                        resolve(null);
                    });
                }

                const inputElem = inputContainer.querySelector('input,textarea');
                inputElem?.focus?.();
                // Press 'Enter'
                if (!showCancel && inputElem) {
                    inputElem.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            cleanup();
                            resolve(result || textbox.getValue());
                        }
                    });
                }
                break;
            }

            case 'radio': {
                const { message = 'Please select:', items = 'Option 1,Option 2', itemsTitle = 'Option 1,Option 2', defaultSelectedIndex = 0, buttonText = 'OK' } = options;
                dialog.appendChild(createMessageElement(message));

                const radioContainer = document.createElement('div');
                radioContainer.className = `dialog-radio`;
                dialog.appendChild(radioContainer);

                const radiobox = setupRadiobox(
                    radioContainer.className,
                    '',
                    itemsTitle.replaceAll('\n', '<br>'),
                    items,
                    defaultSelectedIndex,
                    null
                );

                dialog.appendChild(createButtonContainer('ok'));
                addButton(dialog, 'ok', buttonText, true, () => {
                    result = radiobox.getValue();
                    cleanup();
                    resolve(result);
                }).focus();
                break;
            }

            case 'confirm': {
                const { message = 'Are you sure?', yesText = 'Yes', noText = 'No' } = options;
                dialog.appendChild(createMessageElement(message));

                dialog.appendChild(createButtonRow('no', 'yes'));
                const yes = addButton(dialog, 'yes', yesText, true, () => {
                    result = true;
                    cleanup();
                    resolve(result);
                });
                escapeButton = addButton(dialog, 'no', noText, false, () => {
                    result = false;
                    cleanup();
                    resolve(result);
                });
                yes.focus();
                break;
            }

            default:
                console.error(`[Dialog] Unknown dialog type: ${type}`);
                cleanup();
                resolve(null);
        }
    });
}

export { setBlur, setNormal, showDialog };
