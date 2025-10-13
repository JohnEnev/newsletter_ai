import crypto from "crypto";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const secret = "test-secret";
const body = "";

const signature = crypto.createHmac("sha256", secret).update(body).digest("base64");

console.log({ signature });
