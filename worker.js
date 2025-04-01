/**
 * Web Worker for message processing
 * 负责处理消息索引和范围操作的后台任务
 */

// 消息索引结构
class MessageIndex {
    constructor() {
        this.hidden = new Set();
        this.visible = new Set();
        this.systemMessages = new Set();
        this.messagePositions = new Map();
        this.lastUpdate = Date.now();
    }

    /**
     * 添加消息到索引
     */
    addMessage(message, position) {
        const messageId = message.id || position;
        this.messagePositions.set(messageId, position);

        if (message.is_system) {
            this.hidden.add(messageId);
            this.systemMessages.add(messageId);
        } else {
            this.visible.add(messageId);
        }
    }

    /**
     * 更新消息状态
     */
    updateMessageState(messageId, isHidden) {
        if (isHidden) {
            this.visible.delete(messageId);
            this.hidden.add(messageId);
        } else {
            this.hidden.delete(messageId);
            this.visible.add(messageId);
        }
        this.lastUpdate = Date.now();
    }

    /**
     * 获取消息状态
     */
    getMessageState(messageId) {
        return {
            isHidden: this.hidden.has(messageId),
            isVisible: this.visible.has(messageId),
            isSystem: this.systemMessages.has(messageId),
            position: this.messagePositions.get(messageId)
        };
    }
}

// 构建消息索引
function buildMessageIndex(messages) {
    const index = new MessageIndex();
    
    messages.forEach((message, position) => {
        index.addMessage(message, position);
    });

    return index;
}

// 处理消息范围
function processMessageRange(messages, index, start, end, unhide) {
    const updates = new Map();
    const batchSize = 50; // 批处理大小

    for (let i = start; i <= end; i += batchSize) {
        const chunkEnd = Math.min(i + batchSize - 1, end);
        
        for (let j = i; j <= chunkEnd; j++) {
            const message = messages[j];
            if (!message) continue;

            const messageId = message.id || j;
            const state = index.getMessageState(messageId);
            
            const shouldUpdate = unhide ? state.isHidden : state.isVisible;

            if (shouldUpdate) {
                updates.set(messageId, {
                    position: j,
                    isHidden: !unhide
                });

                index.updateMessageState(messageId, !unhide);
            }
        }
    }

    return {
        updates,
        index
    };
}

// Worker消息处理
self.onmessage = function(e) {
    try {
        const { operationId, action, data } = e.data;

        switch (action) {
            case 'buildIndex': {
                const index = buildMessageIndex(data.messages);
                self.postMessage({
                    operationId,
                    action: 'indexBuilt',
                    data: { index }
                });
                break;
            }

            case 'processRange': {
                const { messages, start, end, unhide } = data;
                const index = data.index || buildMessageIndex(messages);
                const result = processMessageRange(messages, index, start, end, unhide);
                
                self.postMessage({
                    operationId,
                    action: 'rangeProcessed',
                    data: result
                });
                break;
            }

            default:
                throw new Error(`未知的操作类型: ${action}`);
        }
    } catch (error) {
        self.postMessage({
            operationId: e.data.operationId,
            error: error.message
        });
    }
};

// 错误处理
self.onerror = function(error) {
    self.postMessage({
        error: `Worker错误: ${error.message}`
    });
};
