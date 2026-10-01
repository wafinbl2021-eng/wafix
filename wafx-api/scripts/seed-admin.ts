/**
 * Create the first Wafi X admin from a terminal, without a browser.
 *
 * WHY THIS EXISTS
 * ===============
 * The admin panel derives the password verifier in the browser (see the header of
 * src/crypto.ts for why the KDF cannot run in the Worker). That is the right place
 * for it, but it means bootstrapping has one prerequisite: a browser pointed at
 * the panel. This script removes that prerequisite for the *first* account, which
 * is exactly the one an operator creates while the deployment is still being set
 * up and may not have DNS or a login flow they trust yet.
 *
 * It goes through the same `POST /api/admin/bootstrap` endpoint the panel uses, so
 * the row it creates is audited, validated and rate-limited identically. It does
 * not write to D1 directly: a script that opens the database file behind the
 * Worker's back is a second, undocumented way to create an admin.
 *
 * Only the first account can be created this way. The endpoint refuses every later
 * call, and deliberately so - see the report; adding further admins needs a
 * decision about how they are authorised, which does not exist yet.
 *
 * The password never appears on the command line. `argv` is world-readable in the
 * process table on Linux and lands in shell history either way, so the options are
 * a file path and an interactive prompt.
 *
 *   node scripts/seed-admin.ts --username wafi
 *   node scripts/seed-admin.ts --username wafi --password-file ./pw.txt
 *   node scripts/seed-admin.ts --username wafi --print-only > payload.json
 *
 * BOOTSTRAP_TOKEN must be set in the environment (or in .dev.vars for `wrangler
 * dev`), and the Worker must have been started with the same value.
 */

import { readFileSync } from "node:fs";

import { DEFAULT_ITERATIONS, newSalt } from "../src/crypto.ts";

const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;

interface Options {
  username: string;
  password: string | null;
  printOnly: boolean;
  url: string;
  token: string;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): Options {
  let username: string | null = null;
  let passwordFile: string | null = null;
  let printOnly = false;
  let url = process.env.WAFX_API_URL ?? "http://127.0.0.1:8787";
  let token = process.env.BOOTSTRAP_TOKEN ?? "";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--username":
        username = next();
        break;
      case "--password-file":
        passwordFile = next();
        break;
      case "--url":
        url = next();
        break;
      case "--bootstrap-token-file": {
        token = readSecret(next());
        break;
      }
      case "--print-only":
        printOnly = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(usage());
        process.exit(0);
        break;
      default:
        throw new UsageError(`unknown option ${arg}`);
    }
  }

  if (username === null) throw new UsageError("--username is required");
  if (!USERNAME.test(username)) {
    throw new UsageError(
      "username must be 3-32 characters: lowercase letters, digits, dot, underscore or dash",
    );
  }
  if (!url.startsWith("https://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) {
    throw new UsageError("--url must be https, or http on loopback for local development");
  }

  const password =
    passwordFile === null ? null : readSecret(passwordFile).replace(/\r?\n$/, "");
  if (password !== null && password.length === 0) {
    throw new UsageError("the password file is empty");
  }
  if (printOnly && password !== null) {
    throw new UsageError("--print-only never reads a password: it emits the shape only");
  }
  if (token === "" && !printOnly) {
    throw new UsageError("BOOTSTRAP_TOKEN is not set, and the Worker needs the same value");
  }

  return { username, password, printOnly, url: url.replace(/\/+$/, ""), token };
}

function usage(): string {
  return [
    "Create the first Wafi X admin account.",
    "",
    "  --username <name>           required, 3-32 chars, lowercase",
    "  --password-file <path>      read the password from a file; otherwise prompted",
    "  --bootstrap-token-file <p>  read BOOTSTRAP_TOKEN from a file instead of the env",
    "  --url <origin>              Worker origin (env: WAFX_API_URL, default 127.0.0.1:8787)",
    "  --print-only                print the request body and exit; no password is read",
    "",
  ].join("\n");
}

function readSecret(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UsageError(`could not read ${path}: ${reason}`);
  }
}

/**
 * Reads a password from the terminal without echoing it.
 *
 * On a TTY this reads raw bytes and writes one `*` per character itself, because
 * `readline` has no supported way to mask input and the usual workaround reaches
 * into a private field. Off a TTY it is a plain line on stdin, which is the only
 * option when running unattended - the password arrives through a pipe rather
 * than through scrollback or shell history, so it is still not a command line.
 */
function promptPassword(): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!process.stdin.isTTY) {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        buffer += chunk;
      });
      process.stdin.on("end", () => {
        resolvePromise(buffer.replace(/\r?\n$/, ""));
      });
      process.stdin.on("error", (error) => {
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }

    process.stdout.write("password: ");
    const decoder = new TextDecoder();
    let typed = "";

    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        // \r and \n both end the line, and backspace edits what has been typed.
        if (byte === 0x0d || byte === 0x0a) {
          process.stdout.write("\n");
          process.stdin.off("data", onData);
          resolvePromise(typed);
          return;
        }

        if (byte === 0x7f || byte === 0x08) {
          if (typed.length > 0) {
            typed = typed.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (byte < 0x20) continue;
        typed += decoder.decode(new Uint8Array([byte]), { stream: true });
        process.stdout.write("*");
      }
    };

    process.stdin.on("data", onData);
    process.stdin.on("error", (error) => {
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * PBKDF2-SHA256, 32 bytes out, hex encoded.
 *
 * Byte-for-byte the same derivation as `deriveVerifier` in admin/app.js: the salt
 * is used as the UTF-8 bytes of its hex string rather than being decoded, because
 * that is what the panel does and the two must not drift. A verifier derived
 * differently here would be a password nobody can log in with.
 */
async function deriveVerifier(
  password: string,
  salt: string,
  iterations: number,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations, hash: "SHA-256" },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`seed-admin: ${error.message}\n\n${usage()}`);
      return 2;
    }
    throw error;
  }

  const salt = newSalt();
  const iterations = DEFAULT_ITERATIONS;

  if (options.printOnly) {
    process.stdout.write(
      `${JSON.stringify(
        {
          bootstrap_token: "<BOOTSTRAP_TOKEN>",
          username: options.username,
          verifier: "<64 hex characters>",
          salt,
          iterations,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const password = options.password ?? (await promptPassword());
  if (password.length < 12) {
    process.stderr.write("seed-admin: use at least 12 characters\n");
    return 2;
  }

  process.stderr.write(`deriving a verifier at ${iterations} iterations...\n`);
  const verifier = await deriveVerifier(password, salt, iterations);

  const response = await fetch(`${options.url}/api/admin/bootstrap`, {
    method: "POST",
    // The endpoint is same-origin-only. A terminal has no Origin, so the header
    // is what distinguishes this deliberate call from a page-driven one.
    headers: { "content-type": "application/json", "x-wafi-admin": "1" },
    body: JSON.stringify({
      bootstrap_token: options.token,
      username: options.username,
      verifier,
      salt,
      iterations,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    process.stderr.write(`seed-admin: the Worker refused the request (${response.status})\n${text}\n`);
    return 1;
  }

  process.stdout.write(
    `created admin "${options.username}". Sign in at ${options.url}/admin/ - the password is not stored anywhere.\n`,
  );
  return 0;
}

process.exitCode = await main();
