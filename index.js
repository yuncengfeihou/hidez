import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { hideChatMessageRange } from "../../../chats.js";

const extensionName = "hide-helper";
const defaultSettings = {
    performanceMode: true,  // 默认启用高性能模式
    bitmapThreshold: 500    // 消息量超过500时启用位图优化
};

// 高性能操作核心
class HideHelperCore {
    constructor() {
        this.hiddenBitmap = null;
        this.domUpdateQueue = [];
        this.workerPool = [];
        this.maxWorkers = navigator.hardwareConcurrency || 4;
    }

    init(chatLength) {
        if (chatLength > extension_settings[extensionName]?.bitmapThreshold) {
            this.hiddenBitmap = new Uint8Array(chatLength);
            this.buildBitmap();
        }
    }

    buildBitmap() {
        const { chat } = getContext();
        for (let i = 0; i < chat.length; i++) {
            this.hiddenBitmap[i] = chat[i].is_system ? 1 : 0;
        }
    }

    async optimizedHide(hideAfterIndex) {
        const { chat } = getContext();
        const total = chat.length;
        if (total === 0) return;

        const startTime = performance.now();
        
        if (total > 2000 && extension_settings[extensionName]?.performanceMode) {
            await this.parallelHide(hideAfterIndex);
        } else {
            this.jumpScanHide(hideAfterIndex);
        }

        this.flushDomUpdates();
        console.debug(`HideHelper processed ${total} messages in ${performance.now() - startTime}ms`);
    }

    jumpScanHide(hideAfterIndex) {
        const { chat } = getContext();
        let skipCounter = 0;
        const skipThreshold = Math.max(10, Math.floor(chat.length * 0.01)); // 动态跳跃阈值

        // Phase 1: 向前隐藏旧消息
        for (let i = hideAfterIndex; i >= 0; ) {
            if (this.checkHidden(i)) {
                skipCounter++;
                i -= skipCounter > 3 ? skipThreshold : 1; // 连续跳过时增大步长
                continue;
            }
            
            this.setHidden(i, true);
            skipCounter = 0;
            i--;
        }

        // Phase 2: 向后显示新消息
        for (let i = hideAfterIndex + 1; i < chat.length; ) {
            if (!this.checkHidden(i)) {
                skipCounter++;
                i += skipCounter > 3 ? skipThreshold : 1;
                continue;
            }
            
            this.setHidden(i, false);
            skipCounter = 0;
            i++;
        }
    }

    async parallelHide(hideAfterIndex) {
        const { chat } = getContext();
        const segmentSize = Math.ceil(chat.length / this.maxWorkers);
        const promises = [];

        for (let i = 0; i < this.maxWorkers; i++) {
            const start = i * segmentSize;
            const end = Math.min(start + segmentSize - 1, chat.length - 1);
            
            promises.push(
                this.workerExec({
                    chat: chat.slice(start, end + 1),
                    hideAfterIndex,
                    startIdx: start,
                    isForward: i < this.maxWorkers / 2 // 前半段向前处理
                })
            );
        }

        const results = await Promise.all(promises);
        results.forEach(({ changes }) => {
            changes.forEach(({ index, hide }) => this.setHidden(index, hide, false));
        });
    }

    workerExec(task) {
        return new Promise(resolve => {
            const worker = this.getWorker();
            worker.onmessage = e => {
                this.releaseWorker(worker);
                resolve(e.data);
            };
            worker.postMessage(task);
        });
    }

    getWorker() {
        if (this.workerPool.length > 0) {
            return this.workerPool.pop();
        }
        
        const workerCode = `
            self.onmessage = function(e) {
                const { chat, hideAfterIndex, startIdx, isForward } = e.data;
                const changes = [];
                
                if (isForward) {
                    for (let i = hideAfterIndex; i >= 0; i--) {
                        if (chat[i - startIdx]?.is_system) continue;
                        changes.push({ index: startIdx + i, hide: true });
                    }
                } else {
                    for (let i = hideAfterIndex + 1; i < chat.length; i++) {
                        if (!chat[i - startIdx]?.is_system) continue;
                        changes.push({ index: startIdx + i, hide: false });
                    }
                }
                
                self.postMessage({ changes });
            };
        `;
        
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        return new Worker(URL.createObjectURL(blob));
    }

    releaseWorker(worker) {
        if (this.workerPool.length < this.maxWorkers) {
            this.workerPool.push(worker);
        } else {
            worker.terminate();
        }
    }

    checkHidden(index) {
        return this.hiddenBitmap 
            ? this.hiddenBitmap[index] === 1
            : getContext().chat[index].is_system;
    }

    setHidden(index, hide, enqueue = true) {
        const { chat } = getContext();
        chat[index].is_system = hide;
        if (this.hiddenBitmap) this.hiddenBitmap[index] = hide ? 1 : 0;
        
        if (enqueue) {
            this.domUpdateQueue.push({ index, hide });
            if (this.domUpdateQueue.length > 50) this.flushDomUpdates();
        }
    }

    flushDomUpdates() {
        if (this.domUpdateQueue.length === 0) return;

        const fragment = document.createDocumentFragment();
        const processed = new Set();
        
        // 去重处理
        this.domUpdateQueue.forEach(({ index, hide }) => {
            if (processed.has(index)) return;
            processed.add(index);
            
            const element = document.querySelector(`.mes[mesid="${index}"]`);
            if (element) {
                element.style.display = hide ? 'none' : '';
                fragment.appendChild(element.cloneNode(true));
            }
        });

        requestAnimationFrame(() => {
            $('#chat').append(fragment);
            this.domUpdateQueue = [];
        });
    }
}

// UI和状态管理
class HideHelperUI {
    constructor(core) {
        this.core = core;
        this.currentSettings = null;
    }

    init() {
        this.createUI();
        this.setupEventListeners();
        loadSettings();
    }

    createUI() {
        const panel = document.createElement('div');
        panel.id = 'hide-helper-panel';
        panel.innerHTML = `
            <h4>隐藏助手 <span class="perf-badge">高性能模式</span></h4>
            <div class="hide-helper-section">
                <label for="hide-last-n">保留最近消息数:</label>
                <input type="number" id="hide-last-n" min="0" 
                       placeholder="输入要保留的消息数量">
                <div class="hide-helper-buttons">
                    <button id="hide-apply-btn">立即应用</button>
                    <button id="hide-save-btn">保存设置</button>
                </div>
            </div>
            <div class="hide-stats">
                <span>消息总数: <span id="total-messages">0</span></span>
                <span>隐藏消息: <span id="hidden-count">0</span></span>
            </div>
            <div class="advanced-options">
                <label>
                    <input type="checkbox" id="perf-mode" checked>
                    启用高性能模式
                </label>
            </div>
        `;
        document.getElementById('extensions_settings').appendChild(panel);
    }

    setupEventListeners() {
        $('#hide-apply-btn').on('click', () => this.applySettings());
        $('#hide-save-btn').on('click', () => this.saveSettings());
        $('#perf-mode').on('change', (e) => {
            extension_settings[extensionName].performanceMode = e.target.checked;
            saveSettingsDebounced();
        });

        eventSource.on(event_types.CHAT_CHANGED, () => this.loadChatState());
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            if (this.currentSettings?.hideLastN > 0) {
                this.applySettings();
            }
        });
    }

    async applySettings() {
        const hideLastN = parseInt($('#hide-last-n').val()) || 0;
        const { chat } = getContext();
        
        if (hideLastN <= 0 || hideLastN >= chat.length) {
            await hideChatMessageRange(0, chat.length - 1, true);
            this.updateStats();
            return;
        }

        this.core.init(chat.length);
        const visibleStart = chat.length - hideLastN;
        await this.core.optimizedHide(visibleStart - 1);
        this.updateStats();
    }

    updateStats() {
        const { chat } = getContext();
        const hiddenCount = chat.filter(m => m.is_system).length;
        $('#total-messages').text(chat.length);
        $('#hidden-count').text(hiddenCount);
    }

    loadChatState() {
        const context = getContext();
        const target = context.groupId 
            ? context.groups.find(x => x.id == context.groupId)
            : context.characters[context.characterId];
        
        this.currentSettings = target?.data?.hideHelperSettings || { hideLastN: 0 };
        $('#hide-last-n').val(this.currentSettings.hideLastN);
        this.updateStats();
    }

    saveSettings() {
        const context = getContext();
        const hideLastN = parseInt($('#hide-last-n').val()) || 0;
        const target = context.groupId 
            ? context.groups.find(x => x.id == context.groupId)
            : context.characters[context.characterId];
        
        if (!target) return;

        target.data = target.data || {};
        target.data.hideHelperSettings = { hideLastN };
        this.currentSettings = { hideLastN };
        
        saveSettingsDebounced();
        toastr.success('设置已保存');
        this.updateStats();
    }
}

// 初始化
let coreInstance;
let uiInstance;

jQuery(async () => {
    function loadSettings() {
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], defaultSettings);
    }

    coreInstance = new HideHelperCore();
    uiInstance = new HideHelperUI(coreInstance);
    uiInstance.init();
});
