const { test, expect } = require('@playwright/test');

async function open(page) {
  await page.goto('/tests/nested.html');
  await page.waitForFunction(() => !!window.start);
}

const pixels = page => page.locator('search > canvas').evaluate(canvas => {
  const { data } = canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1);
  return Array.from(data);
});

test('nested native controls own their canvases and sample the scrolling backdrop', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.start());
  await expect(page.locator('summary > canvas')).toHaveCount(1);
  await expect(page.locator('search > canvas')).toHaveCount(1);
  await expect(page.locator('a > canvas')).toHaveCount(1);
  await expect(page.locator('main canvas')).toHaveCount(0);
  // The shared renderer owns one hidden working canvas, not another control.
  await expect(page.locator('body > canvas:visible')).toHaveCount(0);
  await expect.poll(async () => (await pixels(page))[3]).toBeGreaterThan(200);
  const before = await pixels(page);
  await page.locator('main').evaluate(element => { element.scrollTop = 180; });
  await expect.poll(async () => {
    const after = await pixels(page);
    return Math.max(...after.slice(0, 3).map((value, index) => Math.abs(value - before[index])));
  }).toBeGreaterThan(50);
  await page.getByRole('searchbox').fill('a thought');
  await expect(page.getByRole('searchbox')).toHaveValue('a thought');
  await page.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Account menu')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  // Chromium includes keyboard-scrollable regions in sequential focus order.
  if (await page.locator('main').evaluate(element => document.activeElement === element)) {
    await page.keyboard.press('Tab');
  }
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'New conversation' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#new$/);
  await page.setViewportSize({ width: 700, height: 650 });
  await expect.poll(() => page.locator('search > canvas').evaluate(canvas => canvas.width)).toBeGreaterThan(600);
  await page.evaluate(() => { window.instance.destroy(); document.body.classList.remove('ready'); });
  await expect(page.locator('.glass > canvas')).toHaveCount(0);
  await expect(page.getByRole('searchbox')).toHaveValue('a thought');
  await page.evaluate(() => window.start());
  await expect(page.locator('.glass > canvas')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/nested-' + test.info().project.name + '.png' });
});

test('existing direct-child initialization still works', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const panel = document.createElement('button');
    panel.textContent = 'Direct glass';
    panel.style.cssText = 'position:fixed;top:250px;left:30px;width:100px;height:44px;z-index:4;';
    document.body.append(panel);
    window.instance = await window.LiquidGlass.init({ root: document.body, glassElements: [panel] });
  });
  await expect(page.getByRole('button', { name: 'Direct glass' }).locator('canvas')).toHaveCount(1);
  await page.evaluate(() => window.instance.destroy());
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Direct glass' })).toHaveCSS('position', 'fixed');
});

test('invalid backdrop layouts fail before allocating a renderer', async ({ page }) => {
  await open(page);
  const errors = await page.evaluate(async () => {
    const main = document.querySelector('main');
    const summary = document.querySelector('summary');
    const invalid = [
      { backdropRoot: document.body },
      { backdropRoot: document.createElement('main') },
      { glassElements: [main] },
      { glassElements: [main.querySelector('ol')] },
      { glassElements: [document.createElement('button')] },
      { glassElements: [document.querySelector('header'), summary] },
      { glassElements: [document.querySelector('input')] },
    ];
    return Promise.all(invalid.map(async options => {
      try { await window.start(options); return null; }
      catch (error) { return error.message; }
    }));
  });
  expect(errors).toEqual([
    'LiquidGlass: backdropRoot must be a descendant of root.',
    'LiquidGlass: backdropRoot must be a descendant of root.',
    ...Array(3).fill('LiquidGlass: glass elements must be inside root and separate from backdropRoot.'),
    'LiquidGlass: glass elements cannot contain other glass elements.',
    'LiquidGlass: glass elements must support a visible child canvas; use a container around form inputs.',
  ]);
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('destroy restores control styles and keeps text selectable', async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => {
    const search = document.querySelector('search');
    search.style.setProperty('position', 'relative', 'important');
    search.style.setProperty('overflow', 'hidden', 'important');
    search.style.touchAction = 'pan-y';
    document.body.style.userSelect = 'text';
    return search.getAttribute('style');
  });
  await page.evaluate(() => window.start());
  await expect(page.locator('body')).toHaveCSS('user-select', 'text');
  await expect(page.locator('.glass > canvas:not([aria-hidden="true"])')).toHaveCount(0);
  await page.evaluate(() => window.instance.destroy());
  await expect(page.locator('search')).toHaveAttribute('style', before);
  await expect(page.locator('body')).toHaveCSS('user-select', 'text');
  await expect(page.locator('canvas')).toHaveCount(0);
});
