// @ts-check
// Tagged comment preview webview. Content is sanitized HTML rendered by the extension host; this script
// only swaps it in, keeps the scroll position and reports clicks as validated messages.
(function () {
  const vscode = acquireVsCodeApi();
  const content = /** @type {HTMLElement} */ (document.getElementById('content'));

  /** @type {{ scrollY?: number }} */
  const state = vscode.getState() || {};
  if (typeof state.scrollY === 'number') {
    window.scrollTo(0, state.scrollY);
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let scrollTimer;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => vscode.setState({ scrollY: window.scrollY }), 100);
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'update' && typeof message.html === 'string') {
      const y = window.scrollY;
      content.innerHTML = message.html;
      window.scrollTo(0, y);
    } else if (message.type === 'focus' && Number.isInteger(message.block)) {
      content.querySelectorAll('.block.active').forEach((el) => el.classList.remove('active'));
      const el = document.getElementById(`block-${message.block}`);
      if (el) {
        el.classList.add('active');
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  });

  content.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) {
      return;
    }
    const block = Number(target.getAttribute('data-block'));
    if (!Number.isInteger(block) || block < 0) {
      return;
    }
    const action = target.getAttribute('data-action');
    if (action === 'reveal') {
      const line = target.getAttribute('data-line');
      vscode.postMessage(line === null ? { type: 'reveal', block } : { type: 'reveal', block, line: Number(line) });
    } else if (action === 'copy') {
      vscode.postMessage({ type: 'copy', block });
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
