/**
 * DocLight - ICP / public-security filing footer
 *
 * Chinese hosting regulations require a filed site to publish its filing number at
 * the bottom of the page and link it to the authority's lookup portal. The footer is
 * rendered on the server and injected into the served HTML rather than built by the
 * client bundle: compliance checks read the raw response, which would be empty if the
 * number only existed after the SPA booted.
 *
 * Everything here is a pure function of already-resolved configuration, so it can be
 * unit tested without starting the server.
 */

export interface FooterOptions {
  icp: string;
  icpUrl: string;
  police: string;
  policeUrl: string;
  copyright: string;
}

/** Placeholder in public/index.html replaced by the rendered footer. */
export const FOOTER_MARKER = '<!--DOCLIGHT_FOOTER-->';

/** Ministry of Industry and Information Technology filing portal. */
export const ICP_PORTAL = 'https://beian.miit.gov.cn/';

/** Ministry of Public Security filing portal. */
export const POLICE_PORTAL = 'https://beian.mps.gov.cn/';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text before it is embedded into the injected markup. */
export function escapeHtml(value: unknown): string {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Only http(s) links are accepted. The footer is admin-configured text, but it is
 * embedded into every page, so it must not be able to smuggle a `javascript:` URL.
 */
export function safeUrl(value: string, fallback: string): string {
  const url = String(value || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : fallback;
}

/**
 * The public security portal exposes a per-site lookup page keyed by the digits of
 * the filing number (京公网安备11010502030123号 → ...?code=11010502030123). Fall back
 * to the portal root when no usable number is present.
 */
export function policeLookupUrl(number: string): string {
  const code = (String(number || '').match(/\d{6,}/) || [''])[0];
  return code ? `${POLICE_PORTAL}#/query/webSearch?code=${code}` : POLICE_PORTAL;
}

/** Read the footer configuration from the merged application config. */
export function readFooterOptions(config: Pick<FooterOptions, 'icp' | 'icpUrl' | 'police' | 'policeUrl' | 'copyright'>): FooterOptions {
  // The merged config already resolved defaults < file < env; the URL fallbacks below
  // only concern the *link* derived from a filing number, not the value precedence.
  const police = (config.police || '').trim();
  return {
    icp: (config.icp || '').trim(),
    icpUrl: safeUrl(config.icpUrl || '', ICP_PORTAL),
    police,
    policeUrl: safeUrl(config.policeUrl || '', policeLookupUrl(police)),
    copyright: (config.copyright || '').trim(),
  };
}

/**
 * The public security badge uses the icon hosted on the national filing platform
 * (beian.mps.gov.cn), which is the official artwork expected in a filing audit. It is an
 * external resource, so a hand-drawn shield of the same shape is rendered alongside it and
 * revealed only if the image fails to load — the badge must never disappear, and the
 * filing text and link stay intact regardless.
 *
 * The fallback is toggled with removeAttribute rather than `svg.hidden = false`:
 * SVGElement has no `hidden` IDL property, so assigning it would only plant a JS expando
 * and leave the attribute in place (see the same trap in theme-icon.test.ts).
 */
const POLICE_BADGE = [
  '<img class="sf-badge" src="https://beian.mps.gov.cn/web/assets/logo01.6189a29f.png" alt="" width="16" height="16"',
  ` onerror="this.hidden=true;this.nextElementSibling.removeAttribute('hidden')">`,
  '<svg class="sf-badge sf-badge-fallback" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" hidden>',
  '<path d="M8 1.1 2.9 2.9v4.4c0 3.3 2.1 6.2 5.1 7.7 3-1.5 5.1-4.4 5.1-7.7V2.9L8 1.1z" fill="currentColor" opacity=".18"/>',
  '<path d="M8 1.1 2.9 2.9v4.4c0 3.3 2.1 6.2 5.1 7.7 3-1.5 5.1-4.4 5.1-7.7V2.9L8 1.1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  '<path d="M5.8 8.1 7.4 9.7l2.9-3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  '</svg>',
].join('');

/**
 * Render the footer markup, or an empty string when nothing is configured so that a
 * default install stays untouched by filing-specific markup.
 */
export function renderFooter(options: FooterOptions): string {
  const items: string[] = [];

  // Escape *and* re-validate the URLs here rather than trusting the caller: the footer
  // is embedded into every page, so the renderer itself must not be able to emit a
  // `javascript:` link even if it is handed one directly.
  const icpUrl = safeUrl(options.icpUrl, ICP_PORTAL);
  const policeUrl = safeUrl(options.policeUrl, POLICE_PORTAL);

  if (options.copyright) {
    items.push(`<span class="sf-item">${escapeHtml(options.copyright)}</span>`);
  }
  if (options.icp) {
    items.push(
      `<a class="sf-item sf-link" href="${escapeHtml(icpUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(options.icp)}</a>`,
    );
  }
  if (options.police) {
    items.push(
      `<a class="sf-item sf-link" href="${escapeHtml(policeUrl)}" target="_blank" rel="noopener noreferrer">${POLICE_BADGE}${escapeHtml(options.police)}</a>`,
    );
  }

  if (items.length === 0) return '';
  return `<footer id="site-footer" class="site-footer" aria-label="备案信息">${items.join('')}</footer>`;
}

/**
 * Insert the footer into the page shell. The marker keeps the position explicit in
 * index.html; the `</main>` fallback keeps the filing visible even if the marker is
 * removed by accident, because losing it silently would break a legal requirement.
 */
export function injectFooter(html: string, options: FooterOptions): string {
  const footer = renderFooter(options);
  if (html.includes(FOOTER_MARKER)) return html.replace(FOOTER_MARKER, footer);
  if (footer && html.includes('</main>')) return html.replace('</main>', `${footer}\n</main>`);
  return html;
}

/** True when at least one filing field is configured. */
export function hasFiling(options: FooterOptions): boolean {
  return Boolean(options.icp || options.police || options.copyright);
}
