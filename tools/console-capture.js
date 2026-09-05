// Paste this whole file into the browser DevTools console on pineandco.online
// (no userscript needed). It downloads every inline <script> of the page as
// one .js file — commit it to reference/ so the drivers can be written
// against the real game code. Also prints which mini games the code mentions.
(function () {
    const names = ['Quick Tab', 'Shake Master', 'Ice Carving', 'Blind Pour', 'Fresh Squeeze', 'Champagne Launch', 'Stir Stop', 'Where Is My Shot', "Where's My Shot", 'Fly Swat', 'Order Up', 'Table Rush', 'Tip Catch', 'Glass Stack'];
    const texts = Array.from(document.scripts).filter(s => !s.src && s.textContent).map(s => s.textContent);
    const body = texts.map((t, i) => '// ===== inline script #' + (i + 1) + ' (' + t.length + ' chars) =====\n' + t).join('\n\n');
    const all = texts.join('\n');
    console.log('inline scripts:', texts.map(t => t.length), 'external:', Array.from(document.scripts).filter(s => s.src).map(s => s.src));
    console.log('mentions:', names.filter(n => all.includes(n)));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['// ' + location.href + ' — captured ' + new Date().toISOString() + '\n' + body], { type: 'text/javascript' }));
    a.download = 'pineandco-inline-scripts.js';
    document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 1000);
    return 'downloaded pineandco-inline-scripts.js — commit it into reference/';
})();
