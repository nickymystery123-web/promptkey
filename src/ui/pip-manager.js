/* PiPManager — Document Picture-in-Picture API 集成
   将 PromptKey Float 移入独立的置顶窗口，切标签页/最小化浏览器不消失。
   Chrome/Edge 116+ 支持，不支持的浏览器静默降级（按钮不显示）。 */

export function createPipManager({ refs, store }) {
  const supported = "documentPictureInPicture" in window;
  let pipWindow = null;
  let placeholder = null; // 占位元素，PiP 关闭后恢复 DOM 位置

  function isSupported() {
    return supported;
  }

  async function enterPip() {
    if (!supported || pipWindow) return;

    // 创建占位元素，标记 float 原来的位置
    placeholder = document.createComment("pk-float-placeholder");
    refs.float.parentNode.insertBefore(placeholder, refs.float);

    // 请求 PiP 窗口
    pipWindow = await documentPictureInPicture.requestWindow({
      width: 640,
      height: 680
    });

    // 复制所有样式表到 PiP 窗口
    document.querySelectorAll("style, link[rel='stylesheet']").forEach((node) => {
      pipWindow.document.head.appendChild(node.cloneNode(true));
    });

    // 复制 CSS 变量（:root 上可能被 JS 効态设置）
    const rootStyle = document.documentElement.getAttribute("style") || "";
    if (rootStyle) pipWindow.document.documentElement.setAttribute("style", rootStyle);

    // PiP 窗口的 body 样式：居中 float，移除 fixed 定位
    pipWindow.document.body.style.margin = "0";
    pipWindow.document.body.style.background = "var(--pk-surface, #F5F4F0)";
    pipWindow.document.body.style.display = "flex";
    pipWindow.document.body.style.alignItems = "stretch";
    pipWindow.document.body.style.justifyContent = "center";
    pipWindow.document.body.style.overflow = "hidden";

    // 将 float 移入 PiP 窗口
    pipWindow.document.body.appendChild(refs.float);

    // 切换 CSS 模式：PiP 下不再是 fixed 定位
    refs.float.classList.add("pk-pip-mode");
    refs.float.style.left = "";
    refs.float.style.top = "";
    refs.float.style.width = "100%";
    refs.float.style.height = "100%";
    refs.float.style.maxHeight = "none";

    // PiP 窗口关闭时恢复
    pipWindow.addEventListener("pagehide", () => {
      exitPip();
    }, { once: true });

    // 标记状态
    refs.float.dataset.pip = "active";
  }

  function exitPip() {
    if (!pipWindow) return;

    // 移除 PiP 模式样式
    refs.float.classList.remove("pk-pip-mode");
    refs.float.style.left = "";
    refs.float.style.top = "";
    refs.float.style.width = "";
    refs.float.style.height = "";
    refs.float.style.maxHeight = "";
    delete refs.float.dataset.pip;

    // 将 float 移回原文档
    if (placeholder && placeholder.parentNode) {
      placeholder.parentNode.insertBefore(refs.float, placeholder);
      placeholder.remove();
    } else {
      document.body.appendChild(refs.float);
    }
    placeholder = null;

    // 关闭 PiP 窗口（如果还没关）
    try { pipWindow.close(); } catch (_) { /* already closed */ }
    pipWindow = null;

    // 恢复窗口位置（触发 window-manager 重新计算）
    window.dispatchEvent(new Event("resize"));
  }

  function isActive() {
    return pipWindow !== null;
  }

  function toggle() {
    if (pipWindow) exitPip();
    else enterPip();
  }

  return { isSupported, enterPip, exitPip, isActive, toggle };
}
