// Cursor tab: a small slanted tape tab trails the pointer. Over anything clickable it stretches into
// a bracket around the target; on press it shrinks, and clicking a control snips off two scraps.
// Fine pointers only, never with reduced motion, and the real cursor is left alone.
const fine = matchMedia('(hover: hover) and (pointer: fine)');
const calm = matchMedia('(prefers-reduced-motion: reduce)');

if (fine.matches && !calm.matches) {
  const tab = document.createElement('div');
  tab.className = 'cursor-tab';
  tab.setAttribute('aria-hidden', 'true');
  document.body.append(tab);

  const CLICKABLE = 'a[href], button, summary, select, label, [role="button"]';
  const TEXTY = 'input:not([type="checkbox"]):not([type="radio"]), textarea';
  let x = 0, y = 0, tx = 0, ty = 0, started = false;

  const loop = () => {
    x += (tx - x) * 0.2;
    y += (ty - y) * 0.2;
    tab.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    requestAnimationFrame(loop);
  };

  const stateFor = (target) => {
    if (!(target instanceof Element)) return '';
    if (target.closest(TEXTY)) return 'text';
    return target.closest(CLICKABLE) ? 'link' : '';
  };

  const snip = () => {
    for (const dir of [-1, 1]) {
      const scrap = document.createElement('div');
      scrap.className = 'cursor-scrap';
      scrap.style.transform = `translate(${tx - 7}px, ${ty - 3}px)`;
      document.body.append(scrap);
      scrap.animate(
        [
          { transform: `translate(${tx - 7}px, ${ty - 3}px) rotate(0deg)`, opacity: 1 },
          { transform: `translate(${tx - 7 + dir * 26}px, ${ty - 3 + 16}px) rotate(${dir * 70}deg)`, opacity: 0 },
        ],
        { duration: 480, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }
      ).finished.then(() => scrap.remove(), () => scrap.remove());
    }
  };

  addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    tx = e.clientX; ty = e.clientY;
    if (!started) { x = tx; y = ty; started = true; requestAnimationFrame(loop); }
    tab.classList.add('on');
    tab.dataset.state = stateFor(e.target);
  }, { passive: true });

  addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') return;
    tab.classList.add('pressed');
    if (stateFor(e.target) === 'link') snip();
  });
  addEventListener('pointerup', () => tab.classList.remove('pressed'));
  document.documentElement.addEventListener('mouseleave', () => tab.classList.remove('on'));
}
