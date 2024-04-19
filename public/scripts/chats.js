// Move chat functions here from script.js (eventually)

import css from '../lib/css-parser.mjs';
import {
    addCopyToCodeBlocks,
    appendMediaToMessage,
    callPopup,
    characters,
    chat,
    eventSource,
    event_types,
    getCurrentChatId,
    getRequestHeaders,
    hideSwipeButtons,
    name2,
    reloadCurrentChat,
    saveChatDebounced,
    saveSettingsDebounced,
    showSwipeButtons,
    this_chid,
    saveChatConditional,
    chat_metadata,
} from '../script.js';
import { selected_group } from './group-chats.js';
import { power_user } from './power-user.js';
import {
    extractTextFromHTML,
    extractTextFromMarkdown,
    extractTextFromPDF,
    getBase64Async,
    getStringHash,
    humanFileSize,
    saveBase64AsFile,
} from './utils.js';
import { extension_settings, renderExtensionTemplateAsync, saveMetadataDebounced } from './extensions.js';
import { POPUP_RESULT, POPUP_TYPE, callGenericPopup } from './popup.js';
import { ScraperManager } from './scrapers.js';

/**
 * @typedef {Object} FileAttachment
 * @property {string} url File URL
 * @property {number} size File size
 * @property {string} name File name
 * @property {number} created Timestamp
 * @property {string} [text] File text
 */

const fileSizeLimit = 1024 * 1024 * 10; // 10 MB
const ATTACHMENT_SOURCE = {
    GLOBAL: 'global',
    CHAT: 'chat',
    CHARACTER: 'character',
};

const converters = {
    'application/pdf': extractTextFromPDF,
    'text/html': extractTextFromHTML,
    'text/markdown': extractTextFromMarkdown,
};

/**
 * Determines if the file type has a converter function.
 * @param {string} type MIME type
 * @returns {boolean} True if the file type is convertible, false otherwise.
 */
function isConvertible(type) {
    return Object.keys(converters).includes(type);
}

/**
 * Mark a range of messages as hidden ("is_system") or not.
 * @param {number} start Starting message ID
 * @param {number} end Ending message ID (inclusive)
 * @param {boolean} unhide If true, unhide the messages instead.
 * @returns {Promise<void>}
 */
export async function hideChatMessageRange(start, end, unhide) {
    if (!getCurrentChatId()) return;

    if (isNaN(start)) return;
    if (!end) end = start;
    const hide = !unhide;

    for (let messageId = start; messageId <= end; messageId++) {
        const message = chat[messageId];
        if (!message) continue;

        const messageBlock = $(`.mes[mesid="${messageId}"]`);
        if (!messageBlock.length) continue;

        message.is_system = hide;
        messageBlock.attr('is_system', String(hide));
    }

    // Reload swipes. Useful when a last message is hidden.
    hideSwipeButtons();
    showSwipeButtons();

    saveChatDebounced();
}

/**
 * Mark message as hidden (system message).
 * @deprecated Use hideChatMessageRange.
 * @param {number} messageId Message ID
 * @param {JQuery<Element>} _messageBlock Unused
 * @returns {Promise<void>}
 */
export async function hideChatMessage(messageId, _messageBlock) {
    return hideChatMessageRange(messageId, messageId, false);
}

/**
 * Mark message as visible (non-system message).
 * @deprecated Use hideChatMessageRange.
 * @param {number} messageId Message ID
 * @param {JQuery<Element>} _messageBlock Unused
 * @returns {Promise<void>}
 */
export async function unhideChatMessage(messageId, _messageBlock) {
    return hideChatMessageRange(messageId, messageId, true);
}

/**
 * Adds a file attachment to the message.
 * @param {object} message Message object
 * @returns {Promise<void>} A promise that resolves when file is uploaded.
 */
export async function populateFileAttachment(message, inputId = 'file_form_input') {
    try {
        if (!message) return;
        if (!message.extra) message.extra = {};
        const fileInput = document.getElementById(inputId);
        if (!(fileInput instanceof HTMLInputElement)) return;
        const file = fileInput.files[0];
        if (!file) return;

        const fileBase64 = await getBase64Async(file);
        let base64Data = fileBase64.split(',')[1];

        // If file is image
        if (file.type.startsWith('image/')) {
            const extension = file.type.split('/')[1];
            const imageUrl = await saveBase64AsFile(base64Data, name2, file.name, extension);
            message.extra.image = imageUrl;
            message.extra.inline_image = true;
        } else {
            const slug = getStringHash(file.name);
            const uniqueFileName = `${Date.now()}_${slug}.txt`;

            if (isConvertible(file.type)) {
                try {
                    const converter = converters[file.type];
                    const fileText = await converter(file);
                    base64Data = window.btoa(unescape(encodeURIComponent(fileText)));
                } catch (error) {
                    toastr.error(String(error), 'Could not convert file');
                    console.error('Could not convert file', error);
                }
            }

            const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);

            if (!fileUrl) {
                return;
            }

            message.extra.file = {
                url: fileUrl,
                size: file.size,
                name: file.name,
                created: Date.now(),
            };
        }

    } catch (error) {
        console.error('Could not upload file', error);
    } finally {
        $('#file_form').trigger('reset');
    }
}

/**
 * Uploads file to the server.
 * @param {string} fileName
 * @param {string} base64Data
 * @returns {Promise<string>} File URL
 */
export async function uploadFileAttachment(fileName, base64Data) {
    try {
        const result = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                name: fileName,
                data: base64Data,
            }),
        });

        if (!result.ok) {
            const error = await result.text();
            throw new Error(error);
        }

        const responseData = await result.json();
        return responseData.path;
    } catch (error) {
        toastr.error(String(error), 'Could not upload file');
        console.error('Could not upload file', error);
    }
}

/**
 * Downloads file from the server.
 * @param {string} url File URL
 * @returns {Promise<string>} File text
 */
export async function getFileAttachment(url) {
    try {
        const result = await fetch(url, {
            method: 'GET',
            cache: 'force-cache',
            headers: getRequestHeaders(),
        });

        if (!result.ok) {
            const error = await result.text();
            throw new Error(error);
        }

        const text = await result.text();
        return text;
    } catch (error) {
        toastr.error(error, 'Could not download file');
        console.error('Could not download file', error);
    }
}

/**
 * Validates file to make sure it is not binary or not image.
 * @param {File} file File object
 * @returns {Promise<boolean>} True if file is valid, false otherwise.
 */
async function validateFile(file) {
    const fileText = await file.text();
    const isImage = file.type.startsWith('image/');
    const isBinary = /^[\x00-\x08\x0E-\x1F\x7F-\xFF]*$/.test(fileText);

    if (!isImage && file.size > fileSizeLimit) {
        toastr.error(`File is too big. Maximum size is ${humanFileSize(fileSizeLimit)}.`);
        return false;
    }

    // If file is binary
    if (isBinary && !isImage && !isConvertible(file.type)) {
        toastr.error('Binary files are not supported. Select a text file or image.');
        return false;
    }

    return true;
}

export function hasPendingFileAttachment() {
    const fileInput = document.getElementById('file_form_input');
    if (!(fileInput instanceof HTMLInputElement)) return false;
    const file = fileInput.files[0];
    return !!file;
}

/**
 * Displays file information in the message sending form.
 * @returns {Promise<void>}
 */
async function onFileAttach() {
    const fileInput = document.getElementById('file_form_input');
    if (!(fileInput instanceof HTMLInputElement)) return;
    const file = fileInput.files[0];
    if (!file) return;

    const isValid = await validateFile(file);

    // If file is binary
    if (!isValid) {
        $('#file_form').trigger('reset');
        return;
    }

    $('#file_form .file_name').text(file.name);
    $('#file_form .file_size').text(humanFileSize(file.size));
    $('#file_form').removeClass('displayNone');

    // Reset form on chat change
    eventSource.once(event_types.CHAT_CHANGED, () => {
        $('#file_form').trigger('reset');
    });
}

/**
 * Deletes file from message.
 * @param {number} messageId Message ID
 */
async function deleteMessageFile(messageId) {
    const confirm = await callGenericPopup('Are you sure you want to delete this file?', POPUP_TYPE.CONFIRM);

    if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
        console.debug('Delete file cancelled');
        return;
    }

    const message = chat[messageId];

    if (!message?.extra?.file) {
        console.debug('Message has no file');
        return;
    }

    const url = message.extra.file.url;

    delete message.extra.file;
    $(`.mes[mesid="${messageId}"] .mes_file_container`).remove();
    await saveChatConditional();
    await deleteFileFromServer(url);
}


/**
 * Opens file from message in a modal.
 * @param {number} messageId Message ID
 */
async function viewMessageFile(messageId) {
    const messageFile = chat[messageId]?.extra?.file;

    if (!messageFile) {
        console.debug('Message has no file or it is empty');
        return;
    }

    await openFilePopup(messageFile);
}

/**
 * Inserts a file embed into the message.
 * @param {number} messageId
 * @param {JQuery<HTMLElement>} messageBlock
 * @returns {Promise<void>}
 */
function embedMessageFile(messageId, messageBlock) {
    const message = chat[messageId];

    if (!message) {
        console.warn('Failed to find message with id', messageId);
        return;
    }

    $('#embed_file_input')
        .off('change')
        .on('change', parseAndUploadEmbed)
        .trigger('click');

    async function parseAndUploadEmbed(e) {
        const file = e.target.files[0];
        if (!file) return;

        const isValid = await validateFile(file);

        if (!isValid) {
            $('#file_form').trigger('reset');
            return;
        }

        await populateFileAttachment(message, 'embed_file_input');
        appendMediaToMessage(message, messageBlock);
        await saveChatConditional();
    }
}

/**
 * Appends file content to the message text.
 * @param {object} message Message object
 * @param {string} messageText Message text
 * @returns {Promise<string>} Message text with file content appended.
 */
export async function appendFileContent(message, messageText) {
    if (message.extra?.file) {
        const fileText = message.extra.file.text || (await getFileAttachment(message.extra.file.url));

        if (fileText) {
            const fileWrapped = `${fileText}\n\n`;
            message.extra.fileLength = fileWrapped.length;
            messageText = fileWrapped + messageText;
        }
    }
    return messageText;
}

/**
 * Replaces style tags in the message text with custom tags with encoded content.
 * @param {string} text
 * @returns {string} Encoded message text
 * @copyright https://github.com/kwaroran/risuAI
 */
export function encodeStyleTags(text) {
    const styleRegex = /<style>(.+?)<\/style>/gms;
    return text.replaceAll(styleRegex, (_, match) => {
        return `<custom-style>${escape(match)}</custom-style>`;
    });
}

/**
 * Sanitizes custom style tags in the message text to prevent DOM pollution.
 * @param {string} text Message text
 * @returns {string} Sanitized message text
 * @copyright https://github.com/kwaroran/risuAI
 */
export function decodeStyleTags(text) {
    const styleDecodeRegex = /<custom-style>(.+?)<\/custom-style>/gms;

    return text.replaceAll(styleDecodeRegex, (_, style) => {
        try {
            let styleCleaned = unescape(style).replaceAll(/<br\/>/g, '');
            const ast = css.parse(styleCleaned);
            const rules = ast?.stylesheet?.rules;
            if (rules) {
                for (const rule of rules) {

                    if (rule.type === 'rule') {
                        if (rule.selectors) {
                            for (let i = 0; i < rule.selectors.length; i++) {
                                let selector = rule.selectors[i];
                                if (selector) {
                                    let selectors = (selector.split(' ') ?? []).map((v) => {
                                        if (v.startsWith('.')) {
                                            return '.custom-' + v.substring(1);
                                        }
                                        return v;
                                    }).join(' ');

                                    rule.selectors[i] = '.mes_text ' + selectors;
                                }
                            }
                        }
                    }
                }
            }
            return `<style>${css.stringify(ast)}</style>`;
        } catch (error) {
            return `CSS ERROR: ${error}`;
        }
    });
}

async function openExternalMediaOverridesDialog() {
    const entityId = getCurrentEntityId();

    if (!entityId) {
        toastr.info('No character or group selected');
        return;
    }

    const template = $('#forbid_media_override_template > .forbid_media_override').clone();
    template.find('.forbid_media_global_state_forbidden').toggle(power_user.forbid_external_media);
    template.find('.forbid_media_global_state_allowed').toggle(!power_user.forbid_external_media);

    if (power_user.external_media_allowed_overrides.includes(entityId)) {
        template.find('#forbid_media_override_allowed').prop('checked', true);
    }
    else if (power_user.external_media_forbidden_overrides.includes(entityId)) {
        template.find('#forbid_media_override_forbidden').prop('checked', true);
    }
    else {
        template.find('#forbid_media_override_global').prop('checked', true);
    }

    callPopup(template, 'text', '', { wide: false, large: false });
}

export function getCurrentEntityId() {
    if (selected_group) {
        return String(selected_group);
    }

    return characters[this_chid]?.avatar ?? null;
}

export function isExternalMediaAllowed() {
    const entityId = getCurrentEntityId();
    if (!entityId) {
        return !power_user.forbid_external_media;
    }

    if (power_user.external_media_allowed_overrides.includes(entityId)) {
        return true;
    }

    if (power_user.external_media_forbidden_overrides.includes(entityId)) {
        return false;
    }

    return !power_user.forbid_external_media;
}

function enlargeMessageImage() {
    const mesBlock = $(this).closest('.mes');
    const mesId = mesBlock.attr('mesid');
    const message = chat[mesId];
    const imgSrc = message?.extra?.image;
    const title = message?.extra?.title;

    if (!imgSrc) {
        return;
    }

    const img = document.createElement('img');
    img.classList.add('img_enlarged');
    img.src = imgSrc;
    const imgContainer = $('<div><pre><code></code></pre></div>');
    imgContainer.prepend(img);
    imgContainer.addClass('img_enlarged_container');
    imgContainer.find('code').addClass('txt').text(title);
    const titleEmpty = !title || title.trim().length === 0;
    imgContainer.find('pre').toggle(!titleEmpty);
    addCopyToCodeBlocks(imgContainer);
    callGenericPopup(imgContainer, POPUP_TYPE.TEXT, '', { wide: true, large: true });
}

async function deleteMessageImage() {
    const value = await callGenericPopup('<h3>Delete image from message?<br>This action can\'t be undone.</h3>', POPUP_TYPE.CONFIRM);

    if (value !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const mesBlock = $(this).closest('.mes');
    const mesId = mesBlock.attr('mesid');
    const message = chat[mesId];
    delete message.extra.image;
    delete message.extra.inline_image;
    mesBlock.find('.mes_img_container').removeClass('img_extra');
    mesBlock.find('.mes_img').attr('src', '');
    await saveChatConditional();
}

/**
 * Deletes file from the server.
 * @param {string} url Path to the file on the server
 * @returns {Promise<boolean>} True if file was deleted, false otherwise.
 */
async function deleteFileFromServer(url) {
    try {
        const result = await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: url }),
        });

        if (!result.ok) {
            const error = await result.text();
            throw new Error(error);
        }

        await eventSource.emit(event_types.FILE_ATTACHMENT_DELETED, url);
        return true;
    } catch (error) {
        toastr.error(String(error), 'Could not delete file');
        console.error('Could not delete file', error);
        return false;
    }
}

/**
 * Opens file attachment in a modal.
 * @param {FileAttachment} attachment File attachment
 */
async function openFilePopup(attachment) {
    const fileText = attachment.text || (await getFileAttachment(attachment.url));

    const modalTemplate = $('<div><pre><code></code></pre></div>');
    modalTemplate.find('code').addClass('txt').text(fileText);
    modalTemplate.addClass('file_modal').addClass('textarea_compact').addClass('fontsize90p');
    addCopyToCodeBlocks(modalTemplate);

    callGenericPopup(modalTemplate, POPUP_TYPE.TEXT, '', { wide: true, large: true });
}

/**
 * Deletes an attachment from the server and the chat.
 * @param {FileAttachment} attachment Attachment to delete
 * @param {string} source Source of the attachment
 * @param {function} callback Callback function
 * @returns {Promise<void>} A promise that resolves when the attachment is deleted.
 */
async function deleteAttachment(attachment, source, callback) {
    const confirm = await callGenericPopup('Are you sure you want to delete this attachment?', POPUP_TYPE.CONFIRM);

    if (confirm !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    ensureAttachmentsExist();

    switch (source) {
        case 'global':
            extension_settings.attachments = extension_settings.attachments.filter((a) => a.url !== attachment.url);
            saveSettingsDebounced();
            break;
        case 'chat':
            chat_metadata.attachments = chat_metadata.attachments.filter((a) => a.url !== attachment.url);
            saveMetadataDebounced();
            break;
        case 'character':
            extension_settings.character_attachments[characters[this_chid]?.avatar] = extension_settings.character_attachments[characters[this_chid]?.avatar].filter((a) => a.url !== attachment.url);
            break;
    }

    await deleteFileFromServer(attachment.url);
    callback();
}

/**
 * Opens the attachment manager.
 */
async function openAttachmentManager() {
    /**
     * Renders a list of attachments.
     * @param {FileAttachment[]} attachments List of attachments
     * @param {string} source Source of the attachments
     */
    async function renderList(attachments, source) {
        /**
         * Sorts attachments by sortField and sortOrder.
         * @param {FileAttachment} a First attachment
         * @param {FileAttachment} b Second attachment
         * @returns {number} Sort order
         */
        function sortFn(a, b) {
            const sortValueA = a[sortField];
            const sortValueB = b[sortField];
            if (typeof sortValueA === 'string' && typeof sortValueB === 'string') {
                return sortValueA.localeCompare(sortValueB) * (sortOrder === 'asc' ? 1 : -1);
            }
            return (sortValueA - sortValueB) * (sortOrder === 'asc' ? 1 : -1);
        }

        /**
         * Filters attachments by name.
         * @param {FileAttachment} a Attachment
         * @returns {boolean} True if attachment matches the filter, false otherwise.
         */
        function filterFn(a) {
            if (!filterString) {
                return true;
            }

            return a.name.toLowerCase().includes(filterString.toLowerCase());
        }
        const sources = {
            [ATTACHMENT_SOURCE.GLOBAL]: '.globalAttachmentsList',
            [ATTACHMENT_SOURCE.CHARACTER]: '.characterAttachmentsList',
            [ATTACHMENT_SOURCE.CHAT]: '.chatAttachmentsList',
        };

        template.find(sources[source]).empty();

        // Sort attachments by sortField and sortOrder, and apply filter
        const sortedAttachmentList = attachments.slice().filter(filterFn).sort(sortFn);

        for (const attachment of sortedAttachmentList) {
            const attachmentTemplate = template.find('.attachmentListItemTemplate .attachmentListItem').clone();
            attachmentTemplate.find('.attachmentListItemName').text(attachment.name);
            attachmentTemplate.find('.attachmentListItemSize').text(humanFileSize(attachment.size));
            attachmentTemplate.find('.attachmentListItemCreated').text(new Date(attachment.created).toLocaleString());
            attachmentTemplate.find('.viewAttachmentButton').on('click', () => openFilePopup(attachment));
            attachmentTemplate.find('.deleteAttachmentButton').on('click', () => deleteAttachment(attachment, source, renderAttachments));
            template.find(sources[source]).append(attachmentTemplate);
        }
    }

    /**
     * Renders buttons for the attachment manager.
     */
    async function renderButtons() {
        const sources = {
            [ATTACHMENT_SOURCE.GLOBAL]: '.globalAttachmentsTitle',
            [ATTACHMENT_SOURCE.CHARACTER]: '.characterAttachmentsTitle',
            [ATTACHMENT_SOURCE.CHAT]: '.chatAttachmentsTitle',
        };

        const modal = template.find('.actionButtonsModal').hide();
        const scrapers = ScraperManager.getDataBankScrapers();

        for (const scraper of scrapers) {
            const isAvailable = await ScraperManager.isScraperAvailable(scraper.id);
            if (!isAvailable) {
                continue;
            }

            const buttonTemplate = template.find('.actionButtonTemplate .actionButton').clone();
            buttonTemplate.find('.actionButtonIcon').addClass(scraper.iconClass);
            buttonTemplate.find('.actionButtonText').text(scraper.name);
            buttonTemplate.attr('title', scraper.description);
            buttonTemplate.on('click', () => {
                const target = modal.attr('data-attachment-manager-target');
                runScraper(scraper.id, target, renderAttachments);
            });
            modal.append(buttonTemplate);
        }

        const modalButtonData = Object.entries(sources).map(entry => {
            const [source, selector] = entry;
            const button = template.find(selector).find('.openActionModalButton').get(0);

            if (!button) {
                return;
            }

            const bodyListener = (e) => {
                if (modal.is(':visible') && (!$(e.target).closest('.openActionModalButton').length)) {
                    modal.hide();
                }

                // Replay a click if the modal was already open by another button
                if ($(e.target).closest('.openActionModalButton').length && !modal.is(':visible')) {
                    modal.show();
                }
            };
            document.body.addEventListener('click', bodyListener);

            const popper = Popper.createPopper(button, modal.get(0), { placement: 'bottom-end' });
            button.addEventListener('click', () => {
                modal.attr('data-attachment-manager-target', source);
                modal.toggle();
                popper.update();
            });

            return [popper, bodyListener];
        }).filter(Boolean);

        return () => {
            modalButtonData.forEach(p => {
                const [popper, bodyListener] = p;
                popper.destroy();
                document.body.removeEventListener('click', bodyListener);
            });
            modal.remove();
        };
    }

    async function renderAttachments() {
    /** @type {FileAttachment[]} */
        const globalAttachments = extension_settings.attachments ?? [];
        /** @type {FileAttachment[]} */
        const chatAttachments = chat_metadata.attachments ?? [];
        /** @type {FileAttachment[]} */
        const characterAttachments = extension_settings.character_attachments?.[characters[this_chid]?.avatar] ?? [];

        await renderList(globalAttachments, ATTACHMENT_SOURCE.GLOBAL);
        await renderList(chatAttachments, ATTACHMENT_SOURCE.CHAT);
        await renderList(characterAttachments, ATTACHMENT_SOURCE.CHARACTER);

        const isNotCharacter = this_chid === undefined || selected_group;
        const isNotInChat = getCurrentChatId() === undefined;
        template.find('.characterAttachmentsBlock').toggle(!isNotCharacter);
        template.find('.chatAttachmentsBlock').toggle(!isNotInChat);

        const characterName = characters[this_chid]?.name || 'Anonymous';
        template.find('.characterAttachmentsName').text(characterName);

        const chatName = getCurrentChatId() || 'Unnamed chat';
        template.find('.chatAttachmentsName').text(chatName);
    }

    let sortField = localStorage.getItem('DataBank_sortField') || 'created';
    let sortOrder = localStorage.getItem('DataBank_sortOrder') || 'desc';
    let filterString = '';

    const template = $(await renderExtensionTemplateAsync('attachments', 'manager', {}));

    template.find('.attachmentSearch').on('input', function () {
        filterString = String($(this).val());
        renderAttachments();
    });
    template.find('.attachmentSort').on('change', function () {
        if (!(this instanceof HTMLSelectElement) || this.selectedOptions.length === 0) {
            return;
        }

        sortField = this.selectedOptions[0].dataset.sortField;
        sortOrder = this.selectedOptions[0].dataset.sortOrder;
        localStorage.setItem('DataBank_sortField', sortField);
        localStorage.setItem('DataBank_sortOrder', sortOrder);
        renderAttachments();
    });

    const cleanupFn = await renderButtons();
    await renderAttachments();
    await callGenericPopup(template, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close' });

    cleanupFn();
}

/**
 * Runs a known scraper on a source and saves the result as an attachment.
 * @param {string} scraperId Id of the scraper
 * @param {string} target Target for the attachment
 * @param {function} callback Callback function
 * @returns {Promise<void>} A promise that resolves when the source is scraped.
 */
async function runScraper(scraperId, target, callback) {
    try {
        console.log(`Running scraper ${scraperId} for ${target}`);
        const files = await ScraperManager.runDataBankScraper(scraperId);

        if (!Array.isArray(files)) {
            console.warn('Scraping returned nothing');
            return;
        }

        if (files.length === 0) {
            console.warn('Scraping returned no files');
            toastr.info('No files were scraped.', 'Data Bank');
            return;
        }

        for (const file of files) {
            await uploadFileAttachmentToServer(file, target);
        }

        toastr.success(`Scraped ${files.length} files from ${scraperId} to ${target}.`, 'Data Bank');
        callback();
    }
    catch (error) {
        console.error('Scraping failed', error);
        toastr.error('Check browser console for details.', 'Scraping failed');
    }
}

/**
 * Uploads a file attachment to the server.
 * @param {File} file File to upload
 * @param {string} target Target for the attachment
 * @returns
 */
async function uploadFileAttachmentToServer(file, target) {
    const isValid = await validateFile(file);

    if (!isValid) {
        return;
    }

    let base64Data = await getBase64Async(file);
    const slug = getStringHash(file.name);
    const uniqueFileName = `${Date.now()}_${slug}.txt`;

    if (isConvertible(file.type)) {
        try {
            const converter = converters[file.type];
            const fileText = await converter(file);
            base64Data = window.btoa(unescape(encodeURIComponent(fileText)));
        } catch (error) {
            toastr.error(String(error), 'Could not convert file');
            console.error('Could not convert file', error);
        }
    } else {
        const fileText = await file.text();
        base64Data = window.btoa(unescape(encodeURIComponent(fileText)));
    }

    const fileUrl = await uploadFileAttachment(uniqueFileName, base64Data);
    const convertedSize = Math.round(base64Data.length * 0.75);

    if (!fileUrl) {
        return;
    }

    const attachment = {
        url: fileUrl,
        size: convertedSize,
        name: file.name,
        created: Date.now(),
    };

    ensureAttachmentsExist();

    switch (target) {
        case ATTACHMENT_SOURCE.GLOBAL:
            extension_settings.attachments.push(attachment);
            saveSettingsDebounced();
            break;
        case ATTACHMENT_SOURCE.CHAT:
            chat_metadata.attachments.push(attachment);
            saveMetadataDebounced();
            break;
        case ATTACHMENT_SOURCE.CHARACTER:
            extension_settings.character_attachments[characters[this_chid]?.avatar].push(attachment);
            saveSettingsDebounced();
            break;
    }
}

function ensureAttachmentsExist() {
    if (!Array.isArray(extension_settings.attachments)) {
        extension_settings.attachments = [];
    }

    if (!Array.isArray(chat_metadata.attachments)) {
        chat_metadata.attachments = [];
    }

    if (this_chid !== undefined && characters[this_chid]) {
        if (!extension_settings.character_attachments) {
            extension_settings.character_attachments = {};
        }

        if (!Array.isArray(extension_settings.character_attachments[characters[this_chid].avatar])) {
            extension_settings.character_attachments[characters[this_chid].avatar] = [];
        }
    }
}

/**
 * Gets all currently available attachments.
 * @returns {FileAttachment[]} List of attachments
 */
export function getDataBankAttachments() {
    ensureAttachmentsExist();
    const globalAttachments = extension_settings.attachments ?? [];
    const chatAttachments = chat_metadata.attachments ?? [];
    const characterAttachments = extension_settings.character_attachments?.[characters[this_chid]?.avatar] ?? [];

    return [...globalAttachments, ...chatAttachments, ...characterAttachments];
}

jQuery(function () {
    $(document).on('click', '.mes_hide', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await hideChatMessageRange(messageId, messageId, false);
    });

    $(document).on('click', '.mes_unhide', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await hideChatMessageRange(messageId, messageId, true);
    });

    $(document).on('click', '.mes_file_delete', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await deleteMessageFile(messageId);
    });

    $(document).on('click', '.mes_file_open', async function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        await viewMessageFile(messageId);
    });

    // Do not change. #attachFile is added by extension.
    $(document).on('click', '#attachFile', function () {
        $('#file_form_input').trigger('click');
    });

    // Do not change. #manageAttachments is added by extension.
    $(document).on('click', '#manageAttachments', function () {
        openAttachmentManager();
    });

    $(document).on('click', '.mes_embed', function () {
        const messageBlock = $(this).closest('.mes');
        const messageId = Number(messageBlock.attr('mesid'));
        embedMessageFile(messageId, messageBlock);
    });

    $(document).on('click', '.editor_maximize', function () {
        const broId = $(this).attr('data-for');
        const bro = $(`#${broId}`);
        const withTab = $(this).attr('data-tab');

        if (!bro.length) {
            console.error('Could not find editor with id', broId);
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.classList.add('height100p', 'wide100p', 'flex-container');
        wrapper.classList.add('flexFlowColumn', 'justifyCenter', 'alignitemscenter');
        const textarea = document.createElement('textarea');
        textarea.value = String(bro.val());
        textarea.classList.add('height100p', 'wide100p');
        textarea.addEventListener('input', function () {
            bro.val(textarea.value).trigger('input');
        });
        wrapper.appendChild(textarea);

        if (withTab) {
            textarea.addEventListener('keydown', (evt) => {
                if (evt.key == 'Tab' && !evt.shiftKey && !evt.ctrlKey && !evt.altKey) {
                    evt.preventDefault();
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    if (end - start > 0 && textarea.value.substring(start, end).includes('\n')) {
                        const lineStart = textarea.value.lastIndexOf('\n', start);
                        const count = textarea.value.substring(lineStart, end).split('\n').length - 1;
                        textarea.value = `${textarea.value.substring(0, lineStart)}${textarea.value.substring(lineStart, end).replace(/\n/g, '\n\t')}${textarea.value.substring(end)}`;
                        textarea.selectionStart = start + 1;
                        textarea.selectionEnd = end + count;
                    } else {
                        textarea.value = `${textarea.value.substring(0, start)}\t${textarea.value.substring(end)}`;
                        textarea.selectionStart = start + 1;
                        textarea.selectionEnd = end + 1;
                    }
                } else if (evt.key == 'Tab' && evt.shiftKey && !evt.ctrlKey && !evt.altKey) {
                    evt.preventDefault();
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const lineStart = textarea.value.lastIndexOf('\n', start);
                    const count = textarea.value.substring(lineStart, end).split('\n\t').length - 1;
                    textarea.value = `${textarea.value.substring(0, lineStart)}${textarea.value.substring(lineStart, end).replace(/\n\t/g, '\n')}${textarea.value.substring(end)}`;
                    textarea.selectionStart = start - 1;
                    textarea.selectionEnd = end - count;
                }
            });
        }

        callPopup(wrapper, 'text', '', { wide: true, large: true });
    });

    $(document).on('click', 'body.documentstyle .mes .mes_text', function () {
        if ($('.edit_textarea').length) return;
        $(this).closest('.mes').find('.mes_edit').trigger('click');
    });

    $(document).on('click', '.open_media_overrides', openExternalMediaOverridesDialog);
    $(document).on('input', '#forbid_media_override_allowed', function () {
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        power_user.external_media_allowed_overrides.push(entityId);
        power_user.external_media_forbidden_overrides = power_user.external_media_forbidden_overrides.filter((v) => v !== entityId);
        saveSettingsDebounced();
        reloadCurrentChat();
    });
    $(document).on('input', '#forbid_media_override_forbidden', function () {
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        power_user.external_media_forbidden_overrides.push(entityId);
        power_user.external_media_allowed_overrides = power_user.external_media_allowed_overrides.filter((v) => v !== entityId);
        saveSettingsDebounced();
        reloadCurrentChat();
    });
    $(document).on('input', '#forbid_media_override_global', function () {
        const entityId = getCurrentEntityId();
        if (!entityId) return;
        power_user.external_media_allowed_overrides = power_user.external_media_allowed_overrides.filter((v) => v !== entityId);
        power_user.external_media_forbidden_overrides = power_user.external_media_forbidden_overrides.filter((v) => v !== entityId);
        saveSettingsDebounced();
        reloadCurrentChat();
    });

    $(document).on('click', '.mes_img_enlarge', enlargeMessageImage);
    $(document).on('click', '.mes_img_delete', deleteMessageImage);

    $('#file_form_input').on('change', onFileAttach);
    $('#file_form').on('reset', function () {
        $('#file_form').addClass('displayNone');
    });
});
