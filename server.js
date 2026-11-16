const express = require("express");
const path = require("path");
const dns = require("dns").promises;
const ipaddr = require("ipaddr.js");
const { Agent, fetch } = require("undici");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

const saved = [
  {
    url: "https://example.edu/robotics",
    title: "Robotics club",
    snippet: "Shop hours, ride board, and the missing hex-driver thread."
  },
  {
    url: "https://example.edu/film",
    title: "Film society",
    snippet: "Thursday screening in the basement theater. Bring a chair."
  }
];

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

function extract(html) {
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [, ""])[1].trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title: title || text.slice(0, 60) || "Untitled",
    snippet: text.slice(0, 240)
  };
}

function isPublicAddress(address) {
  try {
    // ipaddr.process() also converts IPv4-mapped IPv6 addresses to IPv4.
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

async function validateAndResolve(urlString) {
  const url = new URL(urlString);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed.");
  }

  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }

  // Only standard web ports are accepted.
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("The requested port is not allowed.");
  }

  let addresses;

  if (ipaddr.isValid(url.hostname)) {
    addresses = [{ address: url.hostname, family: ipaddr.parse(url.hostname).kind() === "ipv6" ? 6 : 4 }];
  } else {
    addresses = await dns.lookup(url.hostname, {
      all: true,
      verbatim: true
    });
  }

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => !isPublicAddress(address))
  ) {
    throw new Error("The destination is not a public IP address.");
  }

  return { url, addresses };
}

async function readLimitedBody(response) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;

      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("The response exceeded the size limit.");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}

async function safeFetch(startUrl) {
  let currentUrl = startUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    // Validate every destination, including each redirect target.
    const { url, addresses } = await validateAndResolve(currentUrl);

    // Pin the connection to the IP address(es) that were just validated.
    // This helps prevent DNS rebinding between validation and connection.
    const dispatcher = new Agent({
      connect: {
        lookup(hostname, options, callback) {
          if (hostname !== url.hostname) {
            callback(new Error("Unexpected hostname during connection."));
            return;
          }

          const lookupOptions = options || {};
          const candidates = lookupOptions.family
            ? addresses.filter((entry) => entry.family === lookupOptions.family)
            : addresses;

          if (candidates.length === 0) {
            callback(new Error("No validated address is available."));
            return;
          }

          if (lookupOptions.all) {
            callback(null, candidates);
          } else {
            callback(null, candidates[0].address, candidates[0].family);
          }
        }
      }
    });

    try {
      const response = await fetch(url, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      const redirectStatuses = [301, 302, 303, 307, 308];

      if (redirectStatuses.includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();

        if (!location) {
          throw new Error("The redirect did not include a destination.");
        }

        if (redirectCount === MAX_REDIRECTS) {
          throw new Error("The request exceeded the redirect limit.");
        }

        currentUrl = new URL(location, url).toString();
        continue;
      }

      const body = await readLimitedBody(response);

      return {
        status: response.status,
        body
      };
    } finally {
      await dispatcher.close();
    }
  }

  throw new Error("The request exceeded the redirect limit.");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Intentionally retained as the lab's internal demonstration endpoint.
// The patched preview route must not be able to fetch it.
app.get("/internal", (_req, res) => {
  res.type("text/plain").send(
    "Desk note. Not for the public preview list. Release code PREVIEW-4418. Rotate after the spring screening."
  );
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.post("/preview", async (req, res) => {
  const url = String(req.body.url || "").trim();

  if (!url) {
    return res.status(400).send(page("Paste a URL.", saved, null));
  }

  try {
    const response = await safeFetch(url);
    const card = {
      url,
      ...extract(response.body),
      status: response.status
    };

    return res.send(page(null, saved, card));
  } catch (err) {
    console.error("Preview request blocked or failed:", err.message);
    return res.status(400).send(
      page("Could not fetch that public URL.", saved, null)
    );
  }
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(error, cards, fresh) {
  const list = cards
    .map(
      (card) => `<article class="card"><h2>${escapeHtml(card.title)}</h2><p>${escapeHtml(card.snippet)}</p><p class="url">${escapeHtml(card.url)}</p></article>`
    )
    .join("");

  const result = fresh
    ? `<article class="card fresh"><p class="status">${fresh.status}</p><h2>${escapeHtml(fresh.title)}</h2><p>${escapeHtml(fresh.snippet)}</p><p class="url">${escapeHtml(fresh.url)}</p></article>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Preview</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="shell">
    <header class="top">
      <a class="brand" href="/"><span class="mark">Pv</span><span><strong>Preview</strong><em>Club link cards</em></span></a>
    </header>
    <main>
      <section class="hero">
        <h1>Paste a club URL. Get a card.</h1>
        <p class="lede">Preview fetches the page and keeps the title and the first lines. No account required.</p>
      </section>
      <form method="post" action="/preview" class="stack">
        <label><span>URL</span><input name="url" type="url" placeholder="https://..." required></label>
        <button type="submit">Preview</button>
      </form>
      ${error ? `<p class="flash">${escapeHtml(error)}</p>` : ""}
      ${result}
      <h2 class="section">Saved cards</h2>
      ${list}
    </main>
    <footer>Preview is unofficial. It only reads what the URL returns.</footer>
  </div>
</body>
</html>`;
}

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`Preview listening on ${port}`);
});
