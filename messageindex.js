/**
 * 消息索引管理器类
 * 负责管理消息索引和与Web Worker的通信
 */
export class MessageIndexManager {
    constructor() {
        this.worker = null;
        this.index = null;
        this.indexPromise = null;
        this.pendingOperations = new Map();
        this.operationId = 0;
        this.initWorker();
    }

    /**
     * 初始化Web Worker
     */
    initWorker() {
        try {
            this.worker = new Worker(
                new URL('./worker.js', import.meta.url),
                { type: 'module' }
            );
            this.setupWorkerHandlers();
        } catch (error) {
            console.error('初始化消息索引Worker失败:', error);
            // 降级到同步处理
            this.worker = null;
        }
    }

    /**
     * 设置Worker消息处理器
     */
    setupWorkerHandlers() {
        if (!this.worker) return;

        this.worker.onmessage = (e) => {
            const { action, operationId, data, error } = e.data;

            const pendingOperation = this.pendingOperations.get(operationId);
            if (!pendingOperation) return;

            const { resolve, reject } = pendingOperation;
            this.pendingOperations.delete(operationId);

            if (error) {
                reject(new Error(error));
                return;
            }

            switch (action) {
                case 'indexBuilt':
                    this.index = data.index;
                    resolve(this.index);
                    break;

                case 'rangeProcessed':
                    this.index = data.index;
                    resolve(data.result);
                    break;

                default:
                    reject(new Error(`未知的Worker操作: ${action}`));
            }
        };

        this.worker.onerror = (error) => {
            console.error('Worker错误:', error);
            this.handleWorkerError(error);
        };
    }

    /**
     * 处理Worker错误
     */
    handleWorkerError(error) {
        this.worker = null;
        // 通知所有待处理操作失败
        for (const [, operation] of this.pendingOperations) {
            operation.reject(error);
        }
        this.pendingOperations.clear();
    }

    /**
     * 发送操作到Worker并等待结果
     */
    async sendToWorker(action, data) {
        if (!this.worker) {
            // 降级到同步处理
            return this.processSynchronously(action, data);
        }

        const operationId = ++this.operationId;
        
        return new Promise((resolve, reject) => {
            this.pendingOperations.set(operationId, { resolve, reject });
            
            this.worker.postMessage({
                operationId,
                action,
                data
            });

            // 设置操作超时
            setTimeout(() => {
                if (this.pendingOperations.has(operationId)) {
                    this.pendingOperations.delete(operationId);
                    reject(new Error('操作超时'));
                }
            }, 5000); // 5秒超时
        });
    }

    /**
     * 同步处理操作(Worker不可用时的降级方案)
     */
    processSynchronously(action, data) {
        switch (action) {
            case 'buildIndex':
                return this.buildIndexSync(data.messages);
            case 'processRange':
                return this.processRangeSync(data.messages, data.start, data.end, data.unhide);
            default:
                throw new Error(`未支持的同步操作: ${action}`);
        }
    }

    /**
     * 确保索引已建立
     */
    async ensureIndex(messages) {
        if (!this.indexPromise) {
            this.indexPromise = this.sendToWorker('buildIndex', { messages });
        }
        return this.indexPromise;
    }

    /**
     * 处理消息范围
     */
    async processRange(messages, start, end, unhide) {
        await this.ensureIndex(messages);
        
        return this.sendToWorker('processRange', {
            messages,
            start,
            end,
            unhide
        });
    }

    /**
     * 同步构建索引
     */
    buildIndexSync(messages) {
        const index = {
            hidden: new Set(),
            visible: new Set(),
            systemMessages: new Set(),
            messagePositions: new Map(),
            lastUpdate: Date.now()
        };

        messages.forEach((msg, pos) => {
            const messageId = msg.id || pos;
            index.messagePositions.set(messageId, pos);

            if (msg.is_system) {
                index.hidden.add(messageId);
                index.systemMessages.add(messageId);
            } else {
                index.visible.add(messageId);
            }
        });

        this.index = index;
        return { index };
    }

    /**
     * 同步处理消息范围
     */
    processRangeSync(messages, start, end, unhide) {
        const updates = new Map();
        const index = this.index || this.buildIndexSync(messages).index;

        for (let i = start; i <= end; i++) {
            const message = messages[i];
            if (!message) continue;

            const messageId = message.id || i;
            const shouldUpdate = unhide ? 
                index.hidden.has(messageId) :
                index.visible.has(messageId);

            if (shouldUpdate) {
                updates.set(messageId, {
                    position: i,
                    isHidden: !unhide
                });

                // 更新索引
                if (unhide) {
                    index.hidden.delete(messageId);
                    index.visible.add(messageId);
                } else {
                    index.visible.delete(messageId);
                    index.hidden.add(messageId);
                }
            }
        }

        return {
            result: { updates },
            index
        };
    }

    /**
     * 公共API: 检查消息是否隐藏
     */
    isMessageHidden(messageId) {
        return this.index?.hidden.has(messageId) ?? false;
    }

    /**
     * 公共API: 检查消息是否可见
     */
    isMessageVisible(messageId) {
        return this.index?.visible.has(messageId) ?? true;
    }

    /**
     * 公共API: 获取消息位置
     */
    getMessagePosition(messageId) {
        return this.index?.messagePositions.get(messageId);
    }

    /**
     * 公共API: 获取索引统计信息
     */
    getIndexStats() {
        if (!this.index) return null;

        return {
            totalMessages: this.index.messagePositions.size,
            hiddenCount: this.index.hidden.size,
            visibleCount: this.index.visible.size,
            systemCount: this.index.systemMessages.size,
            lastUpdate: this.index.lastUpdate
        };
    }
}
