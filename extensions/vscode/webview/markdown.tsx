/**
 * Draws Markdown as Preact elements, from `marked`'s tokens. No HTML string is ever built or inserted, so nothing in
 * a model's output (a script tag, an event handler, a `javascript:` link) can run: raw HTML in the text is shown as
 * text, a link must be http, https or mailto (or a path in the workspace, which becomes a button that asks the
 * controller to open it), and a remote image is shown as its description, not loaded.
 */
import { Lexer, type MarkedToken, type Token } from "marked";
import type { ComponentChild, JSX } from "preact";
import { useMemo } from "preact/hooks";
import { parseFileRef } from "chattree/ui/model/file-ref";
import { FileLink, FileLinkContext, type FileLinks } from "./chat/FileLink.tsx";
import { Icon } from "./icons.tsx";

const KNOWN = new Set([
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "def",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "html",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "tag",
  "text",
]);
const known = (t: Token): t is MarkedToken => KNOWN.has(t.type);
const SAFE_LINK = /^(https?:|mailto:)/i;

function inline(t: Token, key: number): ComponentChild {
  if (!known(t)) return t.raw;
  switch (t.type) {
    case "text":
      return t.tokens === undefined ? t.text : <Inline key={key} tokens={t.tokens} />;
    case "escape":
      return t.text;
    case "strong":
      return (
        <strong key={key}>
          <Inline tokens={t.tokens} />
        </strong>
      );
    case "em":
      return (
        <em key={key}>
          <Inline tokens={t.tokens} />
        </em>
      );
    case "del":
      return (
        <del key={key}>
          <Inline tokens={t.tokens} />
        </del>
      );
    case "codespan":
      return <code key={key}>{t.text}</code>;
    case "br":
      return <br key={key} />;
    case "link": {
      const file = parseFileRef(t.href);
      if (file !== undefined)
        return (
          <FileLink key={key} file={file}>
            <Inline tokens={t.tokens} />
          </FileLink>
        );
      return SAFE_LINK.test(t.href) ? (
        <a key={key} href={t.href} title={t.title ?? undefined} target="_blank" rel="noopener noreferrer">
          <Inline tokens={t.tokens} />
        </a>
      ) : (
        <span key={key}>
          <Inline tokens={t.tokens} />
        </span>
      );
    }
    case "image":
      return (
        <span key={key} class="md-image">
          [image: {t.text === "" ? t.href : t.text}]
        </span>
      );
    case "checkbox":
      return <input key={key} type="checkbox" checked={t.checked} disabled aria-label={t.checked ? "done" : "not done"} />;
    default:
      // Raw HTML and tags are text; definitions and spaces draw nothing.
      return t.type === "html" ? t.raw : null;
  }
}

function Inline({ tokens }: { tokens: Token[] }): JSX.Element {
  return <>{tokens.map(inline)}</>;
}

function CodeBlock({ lang, text }: { lang: string | undefined; text: string }): JSX.Element {
  return (
    <div class="md-code">
      <div class="md-code-head">
        <span>{lang ?? ""}</span>
        <button class="icon-button" title="Copy" aria-label="Copy code" onClick={() => void navigator.clipboard.writeText(text)}>
          <Icon name="copy" />
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function block(t: Token, key: number): ComponentChild {
  if (!known(t)) return <p key={key}>{t.raw}</p>;
  switch (t.type) {
    case "paragraph":
      return (
        <p key={key}>
          <Inline tokens={t.tokens} />
        </p>
      );
    case "text":
      return t.tokens === undefined ? t.text : <Inline key={key} tokens={t.tokens} />;
    case "heading":
      // Headings in a chat reply are small: a level 1 is only a little bigger than the text.
      return (
        <div key={key} class={`md-h md-h${Math.min(t.depth, 4)}`} role="heading" aria-level={Math.min(t.depth + 2, 6)}>
          <Inline tokens={t.tokens} />
        </div>
      );
    case "code":
      return <CodeBlock key={key} lang={t.lang} text={t.text} />;
    case "blockquote":
      return <blockquote key={key}>{t.tokens.map(block)}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "list": {
      const items = t.items.map((item, i) => (
        <li key={i} class={item.task ? "task" : undefined}>
          {item.tokens.map(block)}
        </li>
      ));
      return t.ordered ? (
        <ol key={key} start={typeof t.start === "number" ? t.start : 1}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "table":
      return (
        <div key={key} class="md-table">
          <table>
            <thead>
              <tr>
                {t.header.map((c, i) => (
                  <th key={i} style={{ textAlign: c.align ?? undefined }}>
                    <Inline tokens={c.tokens} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} style={{ textAlign: c.align ?? undefined }}>
                      <Inline tokens={c.tokens} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "html":
      return <p key={key}>{t.raw}</p>;
    case "space":
    case "def":
      return null;
    default:
      return inline(t, key);
  }
}

/** Markdown as elements. A reply that is still arriving can end mid-fence or mid-list; it is drawn as far as it goes. */
export function Markdown({ source, files }: { source: string; files?: FileLinks }): JSX.Element {
  const tokens = useMemo(() => Lexer.lex(source), [source]);
  return (
    <FileLinkContext.Provider value={files}>
      <div class="md">{tokens.map(block)}</div>
    </FileLinkContext.Provider>
  );
}
