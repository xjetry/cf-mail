import test from "node:test";
import assert from "node:assert/strict";
import { parseEmailContent, matchesAllowedSenders } from "../src/mime.ts";

test("parses multipart/alternative quoted-printable Claude magic-link email with soft line breaks and &amp;", () => {
  const raw = [
    "From: Anthropic <noreply@mail.anthropic.com>",
    "To: user01@example.com",
    "Subject: =?UTF-8?B?U2lnbiBpbiB0byBDbGF1ZGU=?=",
    'Content-Type: multipart/alternative; boundary="boundary-42"',
    "",
    "--boundary-42",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Click the link below to sign in:",
    "https://claude.ai/magic-link#token=3DeyJhbGciOiJIUzI1NiJ9.long_pa=",
    "rt_two&redirect=3D%2Fchats",
    "",
    "Or enter verification code: 839201",
    "--boundary-42",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    '<html><body style=3D"color:#123456">',
    '<a href=3D"https://other.example.com/privacy">Privacy</a>',
    '<a href=3D"https://claude.ai/magic-link#token=3DeyJhbGciOiJIUzI1NiJ9.long_pa=',
    'rt_two&amp;redirect=3D%2Fchats">Sign in</a>',
    "</body></html>",
    "--boundary-42--",
    "",
  ].join("\r\n");

  const parsed = parseEmailContent(new TextEncoder().encode(raw));
  assert.ok(parsed.text.includes("Or enter verification code: 839201"));
  assert.equal(
    parsed.links[0],
    "https://claude.ai/magic-link#token=eyJhbGciOiJIUzI1NiJ9.long_part_two&redirect=%2Fchats",
  );
  assert.ok(parsed.links.includes("https://other.example.com/privacy"));
  // CSS color #123456 must NOT be extracted as a 6-digit verification code
  assert.deepEqual(parsed.codes, ["839201"]);
});

test("parses base64 encoded single-part HTML invite email", () => {
  const html =
    '<div>You have been invited! <a href="https://claude.ai/accept-invite?invite_id=inv_123&amp;org=org_456">Accept Invite</a></div>';
  const b64 = Buffer.from(html, "utf-8").toString("base64");
  const raw = [
    "From: no-reply@anthropic.com",
    "To: new@example.com",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64,
  ].join("\r\n");

  const parsed = parseEmailContent(raw);
  assert.equal(
    parsed.links[0],
    "https://claude.ai/accept-invite?invite_id=inv_123&org=org_456",
  );
  assert.ok(parsed.text.includes("You have been invited!"));
});

test("matchesAllowedSenders checks exact domain, subdomains, and exact email", () => {
  assert.equal(matchesAllowedSenders("noreply@mail.anthropic.com", []), true);
  assert.equal(matchesAllowedSenders("noreply@mail.anthropic.com", undefined), true);
  assert.equal(
    matchesAllowedSenders("Anthropic <noreply@mail.anthropic.com>", ["anthropic.com"]),
    true,
  );
  assert.equal(
    matchesAllowedSenders("noreply@anthropic.com", ["anthropic.com"]),
    true,
  );
  assert.equal(
    matchesAllowedSenders("attacker@evil-anthropic.com", ["anthropic.com"]),
    false,
  );
  assert.equal(
    matchesAllowedSenders("bob@gmail.com", ["anthropic.com", "bob@gmail.com"]),
    true,
  );
});

test("ranks direct claude.ai links strictly ahead of mail.anthropic.com click-tracking links", () => {
  const raw = [
    "From: bounces@em9672.mail.anthropic.com",
    "To: u@example.com",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Join here: https://claude.ai/join#direct_token_123",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<a href="https://url8792.mail.anthropic.com/ls/click?upn=logo">Logo</a>',
    '<a href="https://url8792.mail.anthropic.com/ls/click?upn=join">Join</a>',
    "--b1--",
  ].join("\r\n");

  const parsed = parseEmailContent(raw);
  assert.equal(parsed.links[0], "https://claude.ai/join#direct_token_123");
});

