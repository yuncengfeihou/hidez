import { extension_settings, loadExtensionSettings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { MessageIndexManager } from "./messageIndex.js";

const extensionName = "hide-helper";
const defaultSettings = {
    hideLastN: 0,
    lastAppliedSettings: null,
    autoApplyOnLoad: false,
    useIndexing: true, // 新增: 是否使用索引系统
    batchSize: 50 // 新增: 批处理大小设置
};

// 消息索引管理器实例
const messageIndexManager = new MessageIndexManager();

// 初始化扩展设置
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
}

// 优化的消息隐藏函数
async function hideChatMessageRange(start, end = start, unhide = false) {
    const context = getContext();
    const chat = context.chat;
    
    if (!chat?.length || typeof start !== 'number') return;
    
    // 规范化范围
    start = Math.max(0, Math.min(start, chat.length - 1));
    end = Math.max(0, Math.min(end, chat.length - 1));
    [start, end] = [Math.min(start, end), Math.max(start, end)];

    const settings = extension_settings[extensionName];
    
    if (settings.useIndexing) {
        // 使用索引系统处理
        const result = await messageIndexManager.processRange(chat, start, end, unhide);
        await updateDOMWithResult(result);
    } else {
        // 传统批处理方式
        await processBatchedMessages(chat, start, end, unhide);
    }
}

// 使用DocumentFragment批量更新DOM
async function updateDOMWithResult(result) {
    if (!result.updates.size) return;

    await new Promise(resolve => {
        requestAnimationFrame(() => {
            const fragment = document.createDocumentFragment();
            const chat = getContext().chat;
            
            for (const [messageId, update] of result.updates) {
                const messageBlock = $(`.mes[mesid="${messageId}"]`);
                if (messageBlock.length) {
                    messageBlock.attr('is_system', String(update.isHidden));
                    chat[update.position].is_system = update.isHidden;
                    fragment.appendChild(messageBlock[0].cloneNode(true));
                }
            }
            
            const chatContainer = document.getElementById('chat');
            if (chatContainer) {
                chatContainer.innerHTML = '';
                chatContainer.appendChild(fragment);
            }
            
            resolve();
        });
    });
}

// 传统批处理方式处理消息
async function processBatchedMessages(chat, start, end, unhide) {
    const batchSize = extension_settings[extensionName].batchSize;
    const updates = new Map();

    for (let i = start; i <= end; i += batchSize) {
        const chunkEnd = Math.min(i + batchSize - 1, end);
        
        // 收集批次更新
        for (let j = i; j <= chunkEnd; j++) {
            if (chat[j].is_system !== unhide) {
                chat[j].is_system = unhide;
                updates.set(j, unhide);
            }
        }

        // 批量更新DOM
        if (updates.size > 0) {
            await new Promise(resolve => {
                requestAnimationFrame(() => {
                    for (const [messageId, isHidden] of updates) {
                        const messageBlock = $(`.mes[mesid="${messageId}"]`);
                        if (messageBlock.length) {
                            messageBlock.attr('is_system', String(isHidden));
                        }
                    }
                    updates.clear();
                    resolve();
                });
            });
        }
    }
}

// 应用隐藏设置
async function applyHideSettings() {
    const context = getContext();
    const chatLength = context.chat?.length || 0;
    
    if (chatLength === 0) {
        toastr.warning('没有可用的聊天消息');
        return;
    }
    
    const hideLastN = extension_settings[extensionName].hideLastN || 0;
    
    if (hideLastN > 0 && hideLastN < chatLength) {
        const visibleStart = chatLength - hideLastN;
        
        try {
            showLoader();
            // 先取消隐藏所有消息
            await hideChatMessageRange(0, chatLength - 1, true);
            // 然后隐藏指定范围
            await hideChatMessageRange(0, visibleStart - 1, false);
            
            extension_settings[extensionName].lastAppliedSettings = {
                type: 'lastN',
                value: hideLastN,
                timestamp: Date.now()
            };
            
            saveSettingsDebounced();
            toastr.success('隐藏设置已应用');
        } catch (error) {
            console.error('应用隐藏设置时出错:', error);
            toastr.error('应用设置时出错');
        } finally {
            hideLoader();
        }
    } else if (hideLastN === 0) {
        // 显示所有消息
        await hideChatMessageRange(0, chatLength - 1, true);
        extension_settings[extensionName].lastAppliedSettings = null;
        saveSettingsDebounced();
        toastr.success('所有消息已显示');
    }
}

// 创建设置UI
function createSettingsUI() {
    const settingsHtml = `
        <div id="hide-helper-settings" class="hide-helper-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>隐藏消息助手</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="hide-helper-controls">
                        <label for="hide-last-n">隐藏最后N条之前的消息:</label>
                        <input type="number" id="hide-last-n" min="0" class="text_pole" 
                            value="${extension_settings[extensionName].hideLastN}">
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="auto-apply-setting" 
                                ${extension_settings[extensionName].autoApplyOnLoad ? 'checked' : ''}>
                            自动应用上次设置
                        </label>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="use-indexing" 
                                ${extension_settings[extensionName].useIndexing ? 'checked' : ''}>
                            使用索引系统(推荐)
                        </label>
                        
                        <div class="hide-helper-buttons">
                            <button id="apply-hide-settings" class="menu_button">应用设置</button>
                            <button id="reset-hide-settings" class="menu_button">重置</button>
                        </div>
                    </div>
                    <hr class="sysHR">
                    <p class="hint">
                        提示: 使用索引系统可以提高大量消息处理的性能。
                        当前状态: <span id="indexing-status">初始化中...</span>
                    </p>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings').append(settingsHtml);
    setupEventListeners();
    updateIndexingStatus();
}

// 设置事件监听器
function setupEventListeners() {
    // 输入框变更事件
    $('#hide-last-n').on('input', (e) => {
        const value = parseInt(e.target.value) || 0;
        extension_settings[extensionName].hideLastN = value;
        saveSettingsDebounced();
    });

    // 自动应用设置复选框
    $('#auto-apply-setting').on('change', (e) => {
        extension_settings[extensionName].autoApplyOnLoad = e.target.checked;
        saveSettingsDebounced();
    });

    // 使用索引系统复选框
    $('#use-indexing').on('change', (e) => {
        extension_settings[extensionName].useIndexing = e.target.checked;
        saveSettingsDebounced();
        updateIndexingStatus();
    });

    // 应用按钮
    $('#apply-hide-settings').on('click', applyHideSettings);

    // 重置按钮
    $('#reset-hide-settings').on('click', async () => {
        const context = getContext();
        if (context.chat?.length) {
            await hideChatMessageRange(0, context.chat.length - 1, true);
            extension_settings[extensionName].lastAppliedSettings = null;
            saveSettingsDebounced();
            toastr.success('设置已重置');
        }
    });

    // 监听新消息事件
    eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
        if (extension_settings[extensionName].autoApplyOnLoad && 
            extension_settings[extensionName].lastAppliedSettings) {
            await applyLastSettings();
        }
    });

    // 监听聊天改变事件
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        if (extension_settings[extensionName].autoApplyOnLoad && 
            extension_settings[extensionName].lastAppliedSettings) {
            await applyLastSettings();
        }
    });
}

// 更新索引状态显示
function updateIndexingStatus() {
    const statusElement = $('#indexing-status');
    if (extension_settings[extensionName].useIndexing) {
        statusElement.text('已启用 (性能优化模式)');
        statusElement.css('color', 'green');
    } else {
        statusElement.text('未启用 (传统模式)');
        statusElement.css('color', 'orange');
    }
}

// 应用上次保存的设置
async function applyLastSettings() {
    const lastSettings = extension_settings[extensionName].lastAppliedSettings;
    if (!lastSettings) return;

    const context = getContext();
    if (!context.chat?.length) return;

    if (lastSettings.type === 'lastN') {
        extension_settings[extensionName].hideLastN = lastSettings.value;
        await applyHideSettings();
    }
}

// 初始化扩展
jQuery(async () => {
    try {
        loadSettings();
        createSettingsUI();
        
        // 如果启用了自动应用，应用上次的设置
        if (extension_settings[extensionName].autoApplyOnLoad && 
            extension_settings[extensionName].lastAppliedSettings) {
            await applyLastSettings();
        }
        
        console.log('隐藏消息助手已初始化');
    } catch (error) {
        console.error('初始化隐藏消息助手时出错:', error);
        toastr.error('初始化扩展时出错');
    }
});

// 导出必要的函数和变量
export {
    hideChatMessageRange,
    applyHideSettings,
    messageIndexManager
};
