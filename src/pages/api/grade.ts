import type { APIRoute } from "astro";

export const prerender = false;

type Check = {
  name: string;
  points: number;
  passed: boolean;
};

type Category = {
  key: string;
  name: string;
  description: string;
  failLabel: string;
  maxScore: number;
  scoredOut: number;
  percent: number;
  checks: Check[];
};

const FETCH_TIMEOUT_MS = 10_000;
const WEBHOOK_TIMEOUT_MS = 4_000;
const TURNSTILE_TIMEOUT_MS = 4_000;
const RATE_LIMIT_PER_HOUR = 5;
const UA =
  "Mozilla/5.0 (compatible; VelocityWebGrader/1.0; +https://velocitywebstudio.com)";

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("URL is required");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return "https://" + trimmed;
}

function letterGradeFor(total: number): string {
  if (total >= 90) return "A";
  if (total >= 80) return "B";
  if (total >= 70) return "C";
  if (total >= 60) return "D";
  return "F";
}

function scoreLabelFor(total: number): string {
  if (total >= 80)
    return "Your site is performing well. Here is how to keep pushing it.";
  if (total >= 60)
    return "Your site has a solid foundation with room to improve.";
  if (total >= 40)
    return "Your site has significant gaps likely costing you customers.";
  return "Your website has serious issues. Visitors are likely leaving before they ever reach out.";
}

function extractTag(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = html.match(re);
  return m ? stripTags(m[1]).trim() : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function extractMeta(html: string, name: string): string | null {
  const reName = new RegExp(
    `<meta[^>]+name=["']${name}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const reProp = new RegExp(
    `<meta[^>]+property=["']${name}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const reContentFirstName = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*name=["']${name}["']`,
    "i",
  );
  const reContentFirstProp = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*property=["']${name}["']`,
    "i",
  );
  return (
    html.match(reName)?.[1] ??
    html.match(reProp)?.[1] ??
    html.match(reContentFirstName)?.[1] ??
    html.match(reContentFirstProp)?.[1] ??
    null
  );
}

function runChecks(html: string, finalUrl: string): Category[] {
  const lower = html.toLowerCase();
  const isHttps = finalUrl.startsWith("https://");

  const title = extractTag(html, "title");
  const h1 = extractTag(html, "h1");
  const metaDesc = extractMeta(html, "description");
  const ogDesc = extractMeta(html, "og:description");
  const ogSiteName = extractMeta(html, "og:site_name");

  const hasTelLink = /<a[^>]+href=["']tel:/i.test(html);
  const hasViewport =
    /<meta[^>]+name=["']viewport["']/i.test(html) ||
    /<meta[^>]+content=["'][^"']*width=device-width/i.test(html);
  const hasJsonLd = /<script[^>]+type=["']application\/ld\+json["']/i.test(
    html,
  );
  const hasFormOrCta =
    /<form\b/i.test(html) ||
    /<button\b/i.test(html) ||
    /class=["'][^"']*\b(cta|btn|button)\b/i.test(html);

  const reviewKeywords = ["review", "testimonial", "stars", "rated", "google"];
  const hasReviewContent = reviewKeywords.some((k) => lower.includes(k));
  const aboutKeywords = ["about", "team", "founder", "owner"];
  const hasAboutContent = aboutKeywords.some((k) => lower.includes(k));

  const widthMatches = [...html.matchAll(/style=["'][^"']*width:\s*(\d+)px/gi)];
  const hasOversizedWidth = widthMatches.some((m) => parseInt(m[1], 10) > 600);

  const tapTargetSmall = [
    ...html.matchAll(
      /<(?:a|button)\b[^>]*style=["'][^"']*(?:width|height):\s*(\d+)px/gi,
    ),
  ].some((m) => parseInt(m[1], 10) < 32);

  const titleLen = title?.length ?? 0;
  const titleOk = titleLen >= 30 && titleLen <= 60;
  const hasMetaDesc = !!metaDesc && metaDesc.trim().length > 0;
  const hasH1 = !!h1 && h1.trim().length > 0;

  const phoneRegex = /\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/;
  const hasPhoneNAP = phoneRegex.test(stripTags(html));

  const addressKeywords = [
    "address",
    "located",
    "location",
    "suite",
    " st,",
    " ave",
    " blvd",
    " rd,",
    " road",
    " street",
  ];
  const hasZip = /\b\d{5}(?:-\d{4})?\b/.test(html);
  const hasAddress =
    addressKeywords.some((k) => lower.includes(k)) || hasZip;

  const hasMaps =
    lower.includes("google.com/maps") ||
    lower.includes("maps.google.com") ||
    lower.includes("/maps/embed") ||
    lower.includes("directions");

  const businessDescriptionGood =
    (!!metaDesc && metaDesc.trim().length >= 50) ||
    (!!ogDesc && ogDesc.trim().length >= 50);

  const nameSource = (ogSiteName || title || "").split(/[|–—\-:]/)[0].trim();
  const nameWords = nameSource
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const h1Lower = (h1 || "").toLowerCase();
  const nameConsistent =
    nameWords.length > 0 && nameWords.some((w) => h1Lower.includes(w));

  const conversion: Category = {
    key: "conversion",
    name: "Conversion",
    description: "How well your homepage turns visitors into customers.",
    failLabel:
      "Your homepage is missing key elements that convert visitors into customers.",
    maxScore: 20,
    scoredOut: 0,
    percent: 0,
    checks: [
      { name: "Clickable phone number (tel: link)", points: 6, passed: hasTelLink },
      { name: "Clear H1 headline", points: 7, passed: hasH1 },
      { name: "Contact form or CTA button visible", points: 7, passed: hasFormOrCta },
    ],
  };

  const trust: Category = {
    key: "trust",
    name: "Trust",
    description: "Signals that build visitor confidence.",
    failLabel: "Visitors may not feel confident enough to reach out.",
    maxScore: 20,
    scoredOut: 0,
    percent: 0,
    checks: [
      { name: "SSL certificate active (HTTPS)", points: 7, passed: isHttps },
      { name: "Reviews or testimonials present", points: 7, passed: hasReviewContent },
      { name: "About or team content present", points: 6, passed: hasAboutContent },
    ],
  };

  const mobile: Category = {
    key: "mobile",
    name: "Mobile Experience",
    description: "How your site performs on phones and tablets.",
    failLabel: "Your site may not display correctly on mobile devices.",
    maxScore: 20,
    scoredOut: 0,
    percent: 0,
    checks: [
      { name: "Mobile viewport meta tag", points: 8, passed: hasViewport },
      {
        name: "No oversized fixed pixel widths",
        points: 6,
        passed: !hasOversizedWidth,
      },
      {
        name: "Touch-friendly tap targets",
        points: 6,
        passed: !tapTargetSmall,
      },
    ],
  };

  const seo: Category = {
    key: "seo",
    name: "SEO Basics",
    description: "On-page elements that affect search visibility.",
    failLabel: "There are areas where your search visibility could improve.",
    maxScore: 20,
    scoredOut: 0,
    percent: 0,
    checks: [
      { name: "Title tag length (30–60 chars)", points: 7, passed: titleOk },
      { name: "Meta description present", points: 7, passed: hasMetaDesc },
      { name: "H1 tag present", points: 6, passed: hasH1 },
    ],
  };

  const local: Category = {
    key: "local",
    name: "Local Presence",
    description: "Local search and proximity signals.",
    failLabel: "Your local presence signals are weak or missing.",
    maxScore: 10,
    scoredOut: 0,
    percent: 0,
    checks: [
      { name: "Phone number in NAP format", points: 4, passed: hasPhoneNAP },
      { name: "Address or location reference", points: 3, passed: hasAddress },
      { name: "Google Maps embed or directions link", points: 3, passed: hasMaps },
    ],
  };

  const ai: Category = {
    key: "ai",
    name: "AI Visibility",
    description: "How well AI tools can understand your business.",
    failLabel:
      "AI tools like ChatGPT may struggle to understand and recommend your business.",
    maxScore: 10,
    scoredOut: 0,
    percent: 0,
    checks: [
      { name: "Structured data (JSON-LD)", points: 4, passed: hasJsonLd },
      {
        name: "Business description in meta tags",
        points: 3,
        passed: businessDescriptionGood,
      },
      { name: "Consistent business name across title, H1, meta", points: 3, passed: nameConsistent },
    ],
  };

  const categories = [conversion, trust, mobile, seo, local, ai];
  for (const c of categories) {
    c.scoredOut = c.checks.reduce(
      (sum, ck) => sum + (ck.passed ? ck.points : 0),
      0,
    );
    c.percent = Math.round((c.scoredOut / c.maxScore) * 100);
  }
  return categories;
}

function buildTopIssues(categories: Category[]) {
  const failed = categories.flatMap((c) =>
    c.checks
      .filter((ck) => !ck.passed)
      .map((ck) => ({
        name: ck.name,
        points: ck.points,
        category: c.name,
        priority: ck.points >= 6 ? "High" : "Medium",
      })),
  );
  failed.sort((a, b) => b.points - a.points);
  return failed.slice(0, 3);
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
  } finally {
    clearTimeout(id);
  }
}

function getClientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for") || "";
  const first = fwd.split(",")[0]?.trim();
  return first || request.headers.get("x-nf-client-connection-ip") || "unknown";
}

function isOriginAllowed(request: Request): boolean {
  // Always allow in dev (`astro dev`) so localhost works without env setup.
  if (import.meta.env.DEV) return true;
  const allowedRaw = import.meta.env.ALLOWED_ORIGINS;
  if (!allowedRaw) return true; // not configured = allow
  const allowed = String(allowedRaw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin") || "";
  const referer = request.headers.get("referer") || "";
  return allowed.some(
    (a) => origin === a || origin.startsWith(a) || referer.startsWith(a),
  );
}

async function verifyTurnstile(
  token: string | undefined,
  request: Request,
): Promise<boolean> {
  const secret = import.meta.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured = skip (dev mode)
  if (!token) return false;
  const ip = getClientIp(request);
  const form = new FormData();
  form.append("secret", String(secret));
  form.append("response", token);
  if (ip && ip !== "unknown") form.append("remoteip", ip);
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form, signal: controller.signal },
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(id);
  }
}

async function isRateLimited(request: Request): Promise<boolean> {
  const ip = getClientIp(request);
  if (ip === "unknown") return false;
  const hour = Math.floor(Date.now() / (60 * 60 * 1000));
  const key = `rl:${ip}:${hour}`;
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("grader-ratelimit");
    const current = (await store.get(key, { type: "json" })) as number | null;
    const next = (current ?? 0) + 1;
    if (next > RATE_LIMIT_PER_HOUR) return true;
    await store.setJSON(key, next);
    return false;
  } catch {
    // Blobs unavailable (local dev or misconfigured) — fail open.
    return false;
  }
}

async function pushLeadToGhl(payload: Record<string, unknown>): Promise<void> {
  const webhook = import.meta.env.GHL_WEBHOOK_URL;
  if (!webhook) return;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    console.warn("[grade] GHL webhook failed:", (e as Error)?.message);
  } finally {
    clearTimeout(id);
  }
}

export const POST: APIRoute = async ({ request }) => {
  if (!isOriginAllowed(request)) {
    return jsonError("Forbidden.", 403);
  }

  let body: {
    firstName?: string;
    email?: string;
    websiteUrl?: string;
    turnstileToken?: string;
    companyWebsite?: string;
  };
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid request body.", 400);
  }

  // Honeypot — bots typically fill every field. Silent OK so they don't probe.
  if (body.companyWebsite && body.companyWebsite.trim() !== "") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const turnstileOk = await verifyTurnstile(body.turnstileToken, request);
  if (!turnstileOk) {
    return jsonError(
      "Could not verify request. Reload the page and try again.",
      403,
    );
  }

  if (await isRateLimited(request)) {
    return jsonError(
      "You've hit the limit for free grades this hour. Try again later.",
      429,
    );
  }

  const raw = body.websiteUrl;
  if (!raw || typeof raw !== "string") {
    return jsonError("Website URL is required.", 400);
  }
  const firstName = (body.firstName ?? "").toString().trim();
  const email = (body.email ?? "").toString().trim();

  let url: string;
  try {
    url = normalizeUrl(raw);
    new URL(url);
  } catch {
    return jsonError("That URL doesn't look valid. Try again.", 400);
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return jsonError(
        "The site took too long to respond. Try again in a moment.",
        504,
      );
    }
    return jsonError(
      "We couldn't reach that site. Check the URL and try again.",
      502,
    );
  }

  if (!res.ok && res.status >= 500) {
    return jsonError(
      `The site returned an error (${res.status}). Try another URL.`,
      502,
    );
  }

  const html = await res.text();
  const finalUrl = res.url || url;
  const categories = runChecks(html, finalUrl);
  const totalScore = categories.reduce((s, c) => s + c.scoredOut, 0);
  const topIssues = buildTopIssues(categories);

  const categoryScoresText = categories
    .map((c) => `${c.name}: ${c.percent}/100`)
    .join("\n");
  const topIssuesText = topIssues.length
    ? topIssues.map((i) => `[${i.priority}] ${i.name} (${i.category})`).join("\n")
    : "No major issues found.";

  await pushLeadToGhl({
    firstName,
    email,
    websiteUrl: finalUrl,
    totalScore,
    letterGrade: letterGradeFor(totalScore),
    scoreLabel: scoreLabelFor(totalScore),
    categoryScores: categories.map((c) => ({
      name: c.name,
      scored: c.scoredOut,
      max: c.maxScore,
      percent: c.percent,
    })),
    topIssues,
    categoryScoresText,
    topIssuesText,
  });

  return new Response(
    JSON.stringify({
      url: finalUrl,
      totalScore,
      letterGrade: letterGradeFor(totalScore),
      scoreLabel: scoreLabelFor(totalScore),
      categories: categories.map((c) => ({
        key: c.key,
        name: c.name,
        description: c.description,
        failLabel: c.failLabel,
        scoredOut: c.scoredOut,
        maxScore: c.maxScore,
        percent: c.percent,
        checks: c.checks,
      })),
      topIssues,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
