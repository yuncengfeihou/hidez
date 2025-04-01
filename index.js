import { extension_settings, loadExtensionSettings } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";
import { getContext } from "../../../extensions.js";
import { hideChatMessageRange } from "../../../chats.js";

const extensionName = "hide-helper";
const defaultSettings = {
    hideLastN: 0,
    lastAppliedSettings: null
};

// 初始化扩展设置
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
}

// 创建 UI 面板
function createUI() {
    const hideHelperPanel = document.createElement('div');
    hideHelperPanel.id = 'hide-helper-panel';
    hideHelperPanel.innerHTML = `
        <h4>隐藏助手</h4>
        <div class="hide-helper-section">
            <label for="hide-last-n">隐藏楼层:</label>
            <input type="number" id="hide-last-n" min="0" placeholder="隐藏最后N层之前的消息">
            <div id="current-hidden-setting">当前隐藏设置: 无</div>
            <button class="save-settings-btn" id="hide-save-settings-btn">保存当前设置</button>
        </div>
    `;
    document.body.appendChild(hideHelperPanel);

    // 设置事件监听器
    setupEventListeners();

    // 初始化时更新显示
    updateHiddenSettingDisplay();
}

// 设置事件监听器
function setupEventListeners() {
    const hideLastNInput = document.getElementById('hide-last-n');
    
    // 初始化输入框的值
    const initialHiddenFloor = getHiddenFloor();
    hideLastNInput.value = initialHiddenFloor !== null ? initialHiddenFloor : '';
    
    // 输入框事件监听
    hideLastNInput.addEventListener('input', (e) => {
        const value = parseInt(e.target.value) || 0;
        extension_settings[extensionName].hideLastN = value;
        updateHiddenSetting();
        saveSettingsDebounced();
    });

    // 保存按钮事件监听
    document.getElementById('hide-save-settings-btn').addEventListener('click', saveCurrentSettings);

    // 监听聊天切换事件，更新显示
    eventSource.on(event_types.CHAT_CHANGED, updateHiddenSettingDisplay);
}

// 获取当前 character 或 group 的隐藏楼层数
function getHiddenFloor() {
    const context = getContext();
    if (context.characterId !== undefined) {
        return characters[context.characterId]?.data?.hidden_floor ?? null;
    } else if (context.groupId) {
        return groups.find(x => x.id == context.groupId)?.data?.hidden_floor ?? null;
    }
    return null;
}

// 更新当前 character 或 group 的隐藏设置
function updateHiddenSetting() {
    const context = getContext();
    const value = extension_settings[extensionName].hideLastN;
    if (context.characterId !== undefined) {
        if (!characters[context.characterId].data) {
            characters[context.characterId].data = {};
        }
        characters[context.characterId].data.hidden_floor = value;
        saveCharacterDebounced(); // 保存角色数据
    } else if (context.groupId) {
        const group = groups.find(x => x.id == context.groupId);
        if (group) {
            if (!group.data) {
                group.data = {};
            }
            group.data.hidden_floor = value;
            saveGroupChat(context.groupId); // 保存群组数据
        }
    }
    updateHiddenSettingDisplay();
}

// 更新隐藏设置的显示
function updateHiddenSettingDisplay() {
    const hiddenFloor = getHiddenFloor();
    const displayText = hiddenFloor !== null ? hiddenFloor : '无';
    document.getElementById('current-hidden-setting').textContent = `当前隐藏设置: ${displayText}`;
}

// 应用隐藏设置
async function applyHideSettings() {
    const context = getContext();
    const chatLength = context.chat?.length || 0;
    
    if (chatLength === 0) return;
    
    const hideLastN = extension_settings[extensionName].hideLastN || 0;
    
    if (hideLastN > 0 && hideLastN < chatLength) {
        const visibleStart = chatLength - hideLastN;
        // 先取消隐藏所有消息
        await hideChatMessageRange(0, chatLength - 1, true);
        // 然后隐藏指定范围
        await hideChatMessageRange(0, visibleStart - 1, false);
        
        extension_settings[extensionName].lastAppliedSettings = {
            type: 'lastN',
            value: hideLastN
        };
        saveSettingsDebounced();
    } else if (hideLastN === 0) {
        // 取消隐藏所有消息
        await hideChatMessageRange(0, chatLength - 1, true);
        extension_settings[extensionName].lastAppliedSettings = null;
        saveSettingsDebounced();
    }
}

// 保存当前设置并应用
function saveCurrentSettings() {
    const hideLastN = extension_settings[extensionName].hideLastN || 0;
    if (hideLastN >= 0) {
        applyHideSettings();
    }
    toastr.success('隐藏设置已保存并应用');
}

// 应用上次的保存设置
async function applyLastSettings() {
    const lastSettings = extension_settings[extensionName].lastAppliedSettings;
    
    if (!lastSettings) return;
    
    if (lastSettings.type === 'lastN') {
        await applyHideSettings();
    }
}

// 初始化扩展
jQuery(async () => {
    loadSettings();
    createUI();
    
    // 如果有上次保存的设置，延迟应用
    if (extension_settings[extensionName].lastAppliedSettings) {
        setTimeout(applyLastSettings, 1000); // 延迟确保聊天加载完成
    }
});
