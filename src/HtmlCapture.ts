/**
 * HtmlCapture — manages cached DOM-to-canvas snapshots for individual elements.
 *
 * Uses the `html-to-image` library to rasterise DOM nodes into
 * canvas-ready images.  The library handles style inlining, font
 * embedding, canvas/image conversion and all the SVG-foreignObject
 * plumbing internally.
 *
 * Static elements are captured once and cached.  Elements with the
 * `data-dynamic` attribute are re-captured every frame.
 */
import { toCanvas } from 'html-to-image';

interface CacheEntry {
	canvas: HTMLCanvasElement;
	w: number;
	h: number;
}

/**
 * Document-level cache for the prefetched @font-face CSS, shared
 * across every LiquidGlass instance on the page. The first call
 * kicks off the fetch + base64 inlining; every subsequent call
 * returns the same Promise instead of redoing the work. Cleared
 * via `invalidateFontEmbedCache()`.
 */
let _sharedFontEmbedCSS: Promise<string> | null = null;

/**
 * Discard the shared font-embed cache so the next prefetch rebuilds
 * it from scratch. Useful when stylesheets are added at runtime.
 */
export function invalidateFontEmbedCache(): void {
	_sharedFontEmbedCSS = null;
}

async function buildFontEmbedCSS(): Promise<string> {
	const cssTexts: string[] = [];

	// 1. Fetch every <link rel="stylesheet"> directly. fetch() works
	//    for cross-origin sheets that serve CORS-friendly responses
	//    (Google Fonts, jsdelivr, unpkg, etc.).
	const links = Array.from(
		document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
	);
	for (const link of links) {
		if (!link.href) continue;
		try {
			const res = await fetch(link.href);
			if (res.ok) cssTexts.push(await res.text());
		} catch {
			// Network error or CORS blocked — skip this sheet.
		}
	}

	// 2. Pick up inline same-origin @font-face rules from the page's
	//    own <style> blocks. These are readable via CSSOM without
	//    any cross-origin issues.
	for (const sheet of Array.from(document.styleSheets)) {
		if (sheet.href) continue;
		try {
			for (const rule of Array.from(sheet.cssRules || [])) {
				if (rule.type === CSSRule.FONT_FACE_RULE) {
					cssTexts.push(rule.cssText);
				}
			}
		} catch {
			// SecurityError — skip.
		}
	}

	// 3. Extract every top-level @font-face block from the combined
	//    CSS text via regex. This handles the standard Google Fonts
	//    shape (each rule is a flat block at the top level).
	const allCSS = cssTexts.join('\n');
	const fontFaceBlocks = allCSS.match(/@font-face\s*\{[^}]*\}/gi) || [];

	// 4. For each block, replace any url(...) reference with a base64
	//    data URL fetched directly. The original URL may already be
	//    a data: URL — leave those alone.
	const embedded = await Promise.all(
		fontFaceBlocks.map(async (block) => {
			const urlRegex = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;
			const matches = Array.from(block.matchAll(urlRegex));
			let result = block;
			for (const m of matches) {
				const url = m[1];
				if (url.startsWith('data:')) continue;
				try {
					const res = await fetch(url);
					if (!res.ok) continue;
					const blob = await res.blob();
					const dataUrl = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(reader.result as string);
						reader.onerror = reject;
						reader.readAsDataURL(blob);
					});
					result = result.replace(m[0], `url(${dataUrl})`);
				} catch {
					// skip this URL
				}
			}
			return result;
		}),
	);

	const fontEmbedCSS = embedded.join('\n');
	if (fontEmbedCSS === '') {
		console.warn(
			'LiquidGlass: no @font-face rules found on the page; '
			+ 'captured rasters will use system fallback fonts and may '
			+ 'misalign with the live DOM under glass elements.',
		);
	}
	return fontEmbedCSS;
}

export class HtmlCapture {
	readonly root: HTMLElement;
	readonly cache: Map<HTMLElement, CacheEntry>;
	dpr: number;
	/** Elements with an in-flight html-to-image re-capture (dedupe). */
	private readonly _capturing = new Set<HTMLElement>();
	/**
	 * Optional callback fired when an async re-capture finishes and
	 * the cache changes. Receives the element whose cache entry was
	 * just (re)written so the consumer can scope its dirty marking
	 * to glasses that actually intersect that element.
	 */
	onCacheUpdate: ((element: HTMLElement) => void) | null = null;
	/**
	 * Prefetched @font-face CSS (with base64 src URLs) used for every
	 * subsequent toCanvas call. Computed once at init via prefetchFontEmbedCSS.
	 * Empty string = no embeds available, but still passed so html-to-image
	 * skips its noisy CSSOM-walking branch on every capture.
	 */
	private _fontEmbedCSS = '';

	constructor(root: HTMLElement) {
		this.root = root;
		this.cache = new Map();
		this.dpr = 1;
	}

	// ────────────────────────────────────────────
	// Public API
	// ────────────────────────────────────────────

	/**
	 * Resolve the page's @font-face rules into a single CSS string with
	 * every `url(...)` source already inlined as a base64 data URL. The
	 * result is reused on every subsequent toCanvas call so the captured
	 * raster renders text with the page's actual webfonts (e.g. Inter)
	 * instead of system fallbacks. Matching glyph metrics is what makes
	 * the refracted text line up with the live DOM under the glass.
	 *
	 * The build is shared at module scope across every LiquidGlass
	 * instance — the first init() pays the fetch + base64 cost, every
	 * subsequent init() awaits the same Promise.
	 *
	 * Implemented manually rather than via html-to-image's getFontEmbedCSS
	 * because that path walks document.styleSheets via CSSOM, which throws
	 * SecurityError on every cross-origin stylesheet and has a brittle
	 * recovery flow. We just fetch each <link rel="stylesheet"> directly
	 * (CORS-friendly for the typical Google Fonts / CDN cases), regex out
	 * the @font-face blocks, and inline each url(...) ourselves.
	 */
	async prefetchFontEmbedCSS(): Promise<void> {
		if (!_sharedFontEmbedCSS) {
			_sharedFontEmbedCSS = buildFontEmbedCSS();
		}
		this._fontEmbedCSS = await _sharedFontEmbedCSS;
	}

	/**
	 * Update the device pixel ratio used for future captures.
	 */
	resize(dpr = 1): void {
		this.dpr = dpr;
		// Invalidate all caches on resize since element sizes change.
		this.cache.clear();
	}

	/**
	 * Ensure an element's cached canvas is fresh enough for the current DPR.
	 *
	 * Cache semantics:
	 *   - Fresh hit (size matches within 0.5 px) → return immediately.
	 *   - Stale hit (size differs) → keep the stale entry so callers can
	 *     stretch-blit it, and kick off an async re-capture.
	 *   - Cache miss → kick off an async capture.
	 *
	 * Concurrent re-captures for the same element are deduplicated
	 * via the `_capturing` set, so calling this every frame is cheap.
	 */
	async captureElement(element: HTMLElement, force = false): Promise<void> {
		const rect = element.getBoundingClientRect();
		const cssW = rect.width;
		const cssH = rect.height;
		const w = Math.round(cssW * this.dpr);
		const h = Math.round(cssH * this.dpr);

		// Hidden / collapsed element — nothing to capture.
		if (w <= 0 || h <= 0) {
			this.cache.delete(element);
			return;
		}

		const cached = this.cache.get(element);
		const cacheIsFresh = !!cached
			&& cached.canvas.width > 0
			&& cached.canvas.height > 0
			&& Math.abs(cached.w - w) < 0.5
			&& Math.abs(cached.h - h) < 0.5;

		if (!force && cacheIsFresh) return;

		// Dedupe concurrent re-captures for the same element. The
		// previous in-flight call will overwrite the cache when done.
		if (this._capturing.has(element)) return;

		// Canvas elements are drawn directly via the fast path.
		if (element.tagName === 'CANVAS') {
			return;
		}

		this._capturing.add(element);
		try {
			await this._captureWithHtmlToImage(element, w, h, cssW, cssH);
		} finally {
			this._capturing.delete(element);
		}
	}

	/**
	 * Draw the current cached capture for an element into an arbitrary
	 * 2D canvas. Returns true when a cached snapshot was available.
	 */
	drawCachedElement(
		element: HTMLElement,
		targetCtx: CanvasRenderingContext2D,
		x: number,
		y: number,
		w: number,
		h: number,
	): boolean {
		const cached = this.cache.get(element);
		if (!cached) return false;
		if (cached.canvas.width <= 0 || cached.canvas.height <= 0) {
			this.cache.delete(element);
			return false;
		}
		targetCtx.drawImage(cached.canvas, x, y, w, h);
		return true;
	}

	/**
	 * Capture an element's DOM content as a standalone canvas, optionally
	 * excluding specified child nodes from the capture.
	 *
	 * The hideNodes are pruned from the cloned tree via html-to-image's
	 * filter callback, so the live DOM is never mutated and there is no
	 * visible flicker on the page even when this runs inside the render
	 * loop (e.g. on a re-capture triggered by a content change).
	 */
	async captureToCanvas(
		element: HTMLElement,
		cssW: number,
		cssH: number,
		hideNodes: HTMLElement[] | null = null,
	): Promise<HTMLCanvasElement | null> {
		if (cssW <= 0 || cssH <= 0) return null;
		const hideSet: Set<HTMLElement> | null = hideNodes && hideNodes.length
			? new Set(hideNodes)
			: null;

		try {
			const rendered = await toCanvas(element, {
				width: cssW,
				height: cssH,
				pixelRatio: this.dpr,
				backgroundColor: undefined,
				// Reuse the prefetched font embed CSS so the per-glass
				// content image (used for compositing labels on top of
				// the shader output) uses the same Inter face the live
				// page does. Skips html-to-image's noisy CSSOM walk.
				fontEmbedCSS: this._fontEmbedCSS,
				filter: hideSet
					? (node: HTMLElement) => !hideSet.has(node)
					: undefined,
				style: {
					position: 'static',
					top: 'auto',
					left: 'auto',
					right: 'auto',
					bottom: 'auto',
					transform: 'none',
					margin: '0',
				},
			});
			return rendered;
		} catch (err) {
			console.warn('LiquidGlass: captureToCanvas failed for element:', element, err);
			return null;
		}
	}

	/**
	 * Remove an element's entry from the capture cache.
	 */
	invalidateCache(element: HTMLElement): void {
		this.cache.delete(element);
	}

	/** Destroy the capture system and free resources. */
	destroy(): void {
		this.cache.clear();
	}

	// ────────────────────────────────────────────
	// html-to-image back-end
	// ────────────────────────────────────────────

	private async _captureWithHtmlToImage(
		element: HTMLElement,
		w: number,
		h: number,
		cssW: number,
		cssH: number,
	): Promise<void> {
		// Defensive: skip zero-sized captures. captureElement() already
		// guards this but the html-to-image path is reachable from
		// elsewhere, and a 0×0 toCanvas call returns a 0×0 canvas that
		// will throw on every subsequent drawImage.
		if (cssW <= 0 || cssH <= 0 || w <= 0 || h <= 0) return;
		try {
			const rendered = await toCanvas(element, {
				width: cssW,
				height: cssH,
				pixelRatio: this.dpr,
				// Skip media elements — they're drawn via the fast path
				// (drawImage) and html-to-image can't render video frames.
				filter: (node: HTMLElement) => {
					const tag = node.tagName;
					return tag !== 'VIDEO' && tag !== 'CANVAS';
				},
				// Reuse the prefetched font embed CSS so the captured
				// raster renders with the page's actual webfont (e.g.
				// Inter), keeping wraps and glyph positions aligned
				// with the live DOM. Passing a string (even an empty
				// one) makes html-to-image skip its noisy CSSOM-walking
				// branch on every per-element capture.
				fontEmbedCSS: this._fontEmbedCSS,
			});

			this.cache.set(element, { canvas: rendered, w, h });
			this.onCacheUpdate?.(element);
		} catch (err) {
			console.warn('LiquidGlass: html-to-image capture failed for element:', element, err);
		}
	}
}
