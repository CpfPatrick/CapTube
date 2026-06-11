// 引入自定义 console 模块，覆盖内置 console（用于统一日志格式）
const console = require('./console');


// 等待页面完全加载后再执行注入逻辑
window.addEventListener('load', () => {
  // 向页面注入扩展身份信息（扩展 ID 和图标 URL）
  // 使用内联脚本是因为 content script 无法直接向页面 JS 环境写入变量
  let scriptElem = document.createElement('script');
  scriptElem.setAttribute('type', 'text/javascript');
  scriptElem.textContent = `(() => {
      window.__capTubeExtId = ${JSON.stringify(chrome.runtime.id)};
      window.__capTubeIconUrl = ${JSON.stringify(chrome.runtime.getURL('icon32.png'))};
      console.log("CapTube at ${chrome.runtime.id}");
    })();`;
  document.head.appendChild(scriptElem);

  // FIXME: should extract to a function and shared with background.js
  // 从 Chrome 本地存储读取用户设置，并注入到页面 JS 环境供主脚本使用
  chrome.storage.local.get(['settings'], result => {
    const scriptElem = document.createElement('script');
    scriptElem.setAttribute('type', 'text/javascript');
    scriptElem.textContent = `(() => {
        window.__capTubeSettings = ${JSON.stringify(result.settings)};
      })();`;
    document.head.appendChild(scriptElem);
  });

  // 注入编译后的主脚本（此时全局变量已就绪，主脚本可直接读取）
  const scriptsToInject = ['captube.min.js'];
  scriptsToInject.forEach(scriptName => {
    const scriptElem = document.createElement('script');
    scriptElem.setAttribute('type', 'text/javascript');
    scriptElem.setAttribute('src', chrome.runtime.getURL(scriptName));
    document.head.appendChild(scriptElem);
    console.log(`Injected ${scriptName}`);
  });
});
