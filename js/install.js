function showInstallInfo() {
    const isSafari = /iphone|ipad|ipod/i.test(navigator.userAgent) || (/safari/i.test(navigator.userAgent) && !/chrome/i.test(navigator.userAgent));
    const msg = isSafari
        ? 'Натисни бутона "Share" (📤) долу → "Add to Home Screen" → "Add"'
        : 'Натисни трите точки (⋮) горе → "Add to Home Screen" → "Add"';
    showNotification(msg, 'success');
}

if ('serviceWorker' in navigator && !window.matchMedia('(display-mode: standalone)').matches) {
    const d = document.getElementById('installHint');
    if (d) { d.style.display = 'block'; setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity 1s'; setTimeout(() => d.remove(), 1000); }, 7000); }
}
