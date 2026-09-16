/**
 * DocLight - ICP / public-security filing footer (备案号悬挂)
 *
 * Chinese hosting regulations require a filed site to publish its filing number at
 * the bottom of the page and link it to the authority's lookup portal. The footer is
 * rendered on the server and injected into the served HTML rather than built by the
 * client bundle: compliance checks read the raw response, which would be empty if the
 * number only existed after the SPA booted.
 *
 * Everything here is a pure function of the environment so it can be unit tested
 * without starting the server.
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

/** Read the footer configuration from the environment. */
export function readFooterOptions(env: NodeJS.ProcessEnv = process.env): FooterOptions {
  const police = (env.DOCLIGHT_POLICE || '').trim();
  return {
    icp: (env.DOCLIGHT_ICP || '').trim(),
    icpUrl: safeUrl(env.DOCLIGHT_ICP_URL || '', ICP_PORTAL),
    police,
    policeUrl: safeUrl(env.DOCLIGHT_POLICE_URL || '', policeLookupUrl(police)),
    copyright: (env.DOCLIGHT_COPYRIGHT || '').trim(),
  };
}

/**
 * The public security badge is drawn inline instead of pointing at the icon hosted by
 * the portal: an external image would break the footer whenever that host is slow or
 * unreachable, and it inherits `currentColor` so it follows both themes.
 */
const POLICE_BADGE = [
  '<svg class="sf-badge" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">',
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
