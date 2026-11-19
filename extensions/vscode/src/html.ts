/** The page a webview shows: one bundle for every view, which one is chosen by `data-view`. */

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function webviewHtml(i: { view: "graph" | "chat"; script: string; style: string; cspSource: string; nonce: string }): string {
  // Scripts only by nonce; styles from the extension, and inline style attributes (the views size things with them).
  const csp = `default-src 'none'; style-src ${i.cspSource} 'unsafe-inline'; script-src 'nonce-${i.nonce}'; font-src ${i.cspSource};`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${escape(csp)}" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="stylesheet" href="${escape(i.style)}" />
  </head>
  <body data-view="${i.view}">
    <div id="app"></div>
    <script nonce="${i.nonce}" src="${escape(i.script)}"></script>
  </body>
</html>
`;
}
