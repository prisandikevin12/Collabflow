// Error documents contain no request or database values. Returning a complete
// response before React streams is necessary to preserve the real HTTP status.
export function publicStatusDocument(status: 404 | 503): string {
  const title = status === 404
    ? "Creator page not found"
    : "Creator page temporarily unavailable";
  const message = status === 404
    ? "This page isn’t available. Check the link and try again."
    : "Please try this link again in a moment.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${title} | CollabFlow</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; }
    main { box-sizing: border-box; display: flex; flex-direction: column;
      justify-content: center; min-height: 100svh; max-width: 32rem;
      margin: auto; padding: 4rem 1.5rem; }
    h1 { font-size: 1.875rem; line-height: 1.2; letter-spacing: -.025em; }
    p { line-height: 1.65; }
    .status { margin-bottom: 0; font-size: .875rem; }
    a { color: inherit; margin-top: 1.5rem; text-underline-offset: .25em; }
    a:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
  </style>
</head>
<body><main>
  <p class="status">${status}</p>
  <h1>${title}</h1>
  <p>${message}</p>
  <a href="/">Back to CollabFlow</a>
</main></body>
</html>`;
}
