/**
 * Security analysis for detecting vulnerabilities and positive security practices.
 * Analyzes code for OWASP Top 10 vulnerabilities and security anti-patterns.
 */

import fs from "fs-extra";
import path from "path";
import type {
  SecurityVulnerability,
  PositiveSecurityPractice,
  SecurityMetrics,
  SecuritySeverity,
  OWASPCategory,
  SecurityAnalysisResponse
} from "../types.js";

// ============= PATTERN DEFINITIONS =============

type SecurityPattern = {
  id: string;
  title: string;
  pattern: RegExp;
  severity: SecuritySeverity;
  owasp?: OWASPCategory;
  category: string;
  issue: string;
  risk: string[];
  solution: string[];
  fileTypes?: string[];
  exclude?: RegExp;
};

type PositivePattern = {
  id: string;
  title: string;
  pattern: RegExp;
  description: string;
  fileTypes?: string[];
};

// Vulnerability detection patterns
const VULNERABILITY_PATTERNS: SecurityPattern[] = [
  // === SECRETS & CREDENTIALS ===
  {
    id: "hardcoded-secret",
    title: "Hardcoded Secret/API Key",
    pattern: /(?:api[_-]?key|apikey|secret[_-]?key|auth[_-]?token|password|passwd|private[_-]?key)\s*[:=]\s*['"`][^'"`]{8,}['"`]/i,
    severity: "critical",
    owasp: "A02:2021-Cryptographic Failures",
    category: "secrets",
    issue: "Hardcoded secret or API key detected",
    risk: ["Secrets exposed in source control", "Credential theft if code is leaked", "Cannot rotate secrets without code change"],
    solution: ["Use environment variables", "Use secrets manager (AWS Secrets Manager, HashiCorp Vault)", "Add to .gitignore and remove from history"]
  },
  {
    id: "hardcoded-password",
    title: "Hardcoded Password",
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"`][^'"`]{4,}['"`]/i,
    severity: "critical",
    owasp: "A02:2021-Cryptographic Failures",
    category: "secrets",
    issue: "Hardcoded password detected",
    risk: ["Password exposed in source control", "Cannot change password without code deployment"],
    solution: ["Use environment variables", "Implement proper secrets management", "Use password vaults"],
    exclude: /test|mock|example|sample|placeholder|dummy|fake/i
  },
  {
    id: "aws-credentials",
    title: "AWS Credentials Exposed",
    pattern: /(?:AKIA[0-9A-Z]{16}|aws[_-]?(?:access[_-]?key|secret[_-]?key)\s*[:=]\s*['"`][^'"`]+['"`])/i,
    severity: "critical",
    owasp: "A02:2021-Cryptographic Failures",
    category: "secrets",
    issue: "AWS credentials detected in code",
    risk: ["AWS account compromise", "Unauthorized cloud resource access", "Financial liability"],
    solution: ["Use IAM roles", "Use AWS Secrets Manager", "Rotate credentials immediately"]
  },
  {
    id: "jwt-secret",
    title: "JWT Secret Exposed",
    pattern: /jwt[_-]?secret\s*[:=]\s*['"`][^'"`]{8,}['"`]/i,
    severity: "critical",
    owasp: "A02:2021-Cryptographic Failures",
    category: "secrets",
    issue: "JWT signing secret exposed in code",
    risk: ["Token forgery attacks", "Authentication bypass", "Session hijacking"],
    solution: ["Store JWT secret in environment variables", "Use asymmetric keys (RS256) instead of symmetric (HS256)", "Rotate secrets regularly"]
  },

  // === INJECTION VULNERABILITIES ===
  {
    id: "sql-injection",
    title: "Potential SQL Injection",
    pattern: /(?:query|execute|exec)\s*\(\s*['"`](?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b[^'"`]*\$\{|(?:query|execute)\s*\(\s*[`'"].*\+\s*(?:req\.|params\.|body\.|query\.)/i,
    severity: "critical",
    owasp: "A03:2021-Injection",
    category: "injection",
    issue: "Potential SQL injection vulnerability",
    risk: ["Data breach", "Data manipulation", "Authentication bypass", "Full database compromise"],
    solution: ["Use parameterized queries ($1, $2)", "Use ORM with built-in escaping", "Validate and sanitize all inputs"]
  },
  {
    id: "nosql-injection",
    title: "Potential NoSQL Injection",
    pattern: /(?:find|findOne|update|delete|aggregate)\s*\(\s*(?:req\.body|req\.query|req\.params|\{[^}]*\$(?:where|regex|ne|gt|lt))/i,
    severity: "high",
    owasp: "A03:2021-Injection",
    category: "injection",
    issue: "Potential NoSQL injection vulnerability",
    risk: ["Unauthorized data access", "Query manipulation", "Authentication bypass"],
    solution: ["Validate input types", "Use allowlists for query operators", "Sanitize user input before queries"]
  },
  {
    id: "command-injection",
    title: "Command Injection Risk",
    pattern: /(?:exec|execSync|spawn|spawnSync|execFile)\s*\([^)]*(?:\$\{|\+\s*(?:req\.|user|input|param|query|body))/i,
    severity: "critical",
    owasp: "A03:2021-Injection",
    category: "injection",
    issue: "Potential command injection vulnerability",
    risk: ["Remote code execution", "System compromise", "Data exfiltration", "Lateral movement"],
    solution: ["Avoid shell commands with user input", "Use allowlist validation", "Use parameterized commands", "Escape shell arguments properly"]
  },
  {
    id: "eval-usage",
    title: "Dangerous eval() Usage",
    pattern: /\beval\s*\([^)]*(?:req\.|user|input|param|data|\$\{)/i,
    severity: "critical",
    owasp: "A03:2021-Injection",
    category: "injection",
    issue: "eval() with dynamic input detected",
    risk: ["Remote code execution", "XSS attacks", "Complete application compromise"],
    solution: ["Never use eval() with user input", "Use JSON.parse() for JSON", "Use Function constructor carefully", "Consider sandboxing if dynamic execution needed"]
  },
  {
    id: "template-injection",
    title: "Template Injection Risk",
    pattern: /(?:render|compile|template)\s*\([^)]*(?:req\.|user|input|\$\{)/i,
    severity: "high",
    owasp: "A03:2021-Injection",
    category: "injection",
    issue: "Server-side template injection risk",
    risk: ["Remote code execution", "Data exposure", "Server compromise"],
    solution: ["Use parameterized templates", "Sanitize all dynamic content", "Use logic-less templates when possible"]
  },

  // === XSS VULNERABILITIES ===
  {
    id: "dangerous-innerhtml",
    title: "dangerouslySetInnerHTML Usage",
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:/,
    severity: "high",
    owasp: "A03:2021-Injection",
    category: "xss",
    issue: "dangerouslySetInnerHTML usage detected",
    risk: ["XSS attacks", "Session hijacking", "Credential theft", "Malware injection"],
    solution: ["Sanitize HTML with DOMPurify", "Use safe rendering alternatives", "Validate content source"],
    fileTypes: [".tsx", ".jsx", ".ts", ".js"]
  },
  {
    id: "innerhtml-assignment",
    title: "innerHTML Direct Assignment",
    pattern: /\.innerHTML\s*=(?!\s*['"`]\s*['"`])/,
    severity: "high",
    owasp: "A03:2021-Injection",
    category: "xss",
    issue: "Direct innerHTML assignment detected",
    risk: ["XSS attacks", "DOM manipulation", "Script injection"],
    solution: ["Use textContent for plain text", "Use DOMPurify to sanitize HTML", "Use template literals safely"]
  },
  {
    id: "vue-v-html",
    title: "Vue v-html Directive",
    pattern: /v-html\s*=/,
    severity: "high",
    owasp: "A03:2021-Injection",
    category: "xss",
    issue: "Vue v-html directive usage detected",
    risk: ["XSS attacks through unescaped HTML", "Script injection"],
    solution: ["Sanitize content before rendering", "Use v-text for plain text", "Consider markdown renderer with XSS protection"],
    fileTypes: [".vue"]
  },
  {
    id: "document-write",
    title: "document.write Usage",
    pattern: /document\.write\s*\(/,
    severity: "medium",
    owasp: "A03:2021-Injection",
    category: "xss",
    issue: "document.write() usage detected",
    risk: ["XSS vulnerability", "Poor performance", "Race conditions"],
    solution: ["Use DOM manipulation methods", "Use innerHTML with sanitization", "Use modern templating"]
  },

  // === AUTHENTICATION & AUTHORIZATION ===
  {
    id: "insecure-token-storage",
    title: "Insecure Token Storage",
    pattern: /localStorage\.setItem\s*\(\s*['"`](?:token|auth|jwt|session|access|refresh)[^'"`]*['"`]/i,
    severity: "high",
    owasp: "A02:2021-Cryptographic Failures",
    category: "auth",
    issue: "Sensitive token stored in localStorage",
    risk: ["XSS can steal tokens", "Tokens persist after session", "No automatic expiration"],
    solution: ["Use httpOnly cookies", "Use secure session storage", "Use platform secure storage (iOS Keychain, Android Keystore)", "Implement token refresh mechanism"]
  },
  {
    id: "asyncstorage-sensitive",
    title: "AsyncStorage for Sensitive Data",
    pattern: /AsyncStorage\.setItem\s*\(\s*['"`](?:token|auth|jwt|password|secret|key|credential)[^'"`]*['"`]/i,
    severity: "high",
    owasp: "A02:2021-Cryptographic Failures",
    category: "mobile",
    issue: "Sensitive data stored in AsyncStorage (unencrypted)",
    risk: ["Data accessible if device rooted/jailbroken", "No encryption at rest", "Backup extraction vulnerability"],
    solution: ["Use expo-secure-store", "Use react-native-keychain", "Encrypt sensitive data before storage"]
  },
  {
    id: "missing-auth-check",
    title: "Missing Authorization Check",
    pattern: /(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{(?![\s\S]*(?:auth|isAuthenticated|requireAuth|checkAuth|verifyToken|protect|guard))/i,
    severity: "medium",
    owasp: "A01:2021-Broken Access Control",
    category: "auth",
    issue: "Route handler may be missing authorization check",
    risk: ["Unauthorized access to resources", "Data exposure", "Privilege escalation"],
    solution: ["Add authentication middleware", "Verify user permissions", "Implement RBAC/ABAC"]
  },
  {
    id: "jwt-none-algorithm",
    title: "JWT None Algorithm Risk",
    pattern: /(?:algorithm|algorithms)\s*[:=]\s*['"`]none['"`]|verify\s*[:=]\s*false/i,
    severity: "critical",
    owasp: "A07:2021-Auth Failures",
    category: "auth",
    issue: "JWT configured with 'none' algorithm or verification disabled",
    risk: ["Token forgery", "Authentication bypass", "Complete auth compromise"],
    solution: ["Always specify algorithm allowlist", "Never allow 'none' algorithm", "Always verify tokens"]
  },
  {
    id: "weak-jwt-secret",
    title: "Weak JWT Secret",
    pattern: /(?:sign|verify)\s*\([^)]+,\s*['"`][^'"`]{1,20}['"`]/,
    severity: "medium",
    owasp: "A02:2021-Cryptographic Failures",
    category: "crypto",
    issue: "JWT secret appears to be weak (short or simple)",
    risk: ["Brute force attacks", "Token forgery", "Session hijacking"],
    solution: ["Use minimum 256-bit (32 byte) secrets", "Use cryptographically random secrets", "Consider asymmetric keys (RS256)"]
  },

  // === CRYPTOGRAPHIC ISSUES ===
  {
    id: "md5-usage",
    title: "MD5 Hash Usage",
    pattern: /(?:createHash|crypto\.hash)\s*\(\s*['"`]md5['"`]\)/i,
    severity: "medium",
    owasp: "A02:2021-Cryptographic Failures",
    category: "crypto",
    issue: "MD5 hash algorithm detected",
    risk: ["Collision attacks", "Not suitable for security", "Rainbow table attacks"],
    solution: ["Use SHA-256 or SHA-3", "For passwords, use bcrypt/scrypt/argon2", "Use HMAC for message authentication"]
  },
  {
    id: "sha1-usage",
    title: "SHA1 Hash Usage",
    pattern: /(?:createHash|crypto\.hash)\s*\(\s*['"`]sha1['"`]\)/i,
    severity: "low",
    owasp: "A02:2021-Cryptographic Failures",
    category: "crypto",
    issue: "SHA1 hash algorithm detected",
    risk: ["Theoretical collision attacks", "Deprecated for security use", "Not recommended for new systems"],
    solution: ["Use SHA-256 or SHA-3", "For passwords, use bcrypt/scrypt/argon2"]
  },
  {
    id: "weak-random",
    title: "Weak Random Number Generator",
    pattern: /Math\.random\s*\(\s*\).*(?:token|secret|key|password|session|nonce|salt)/i,
    severity: "high",
    owasp: "A02:2021-Cryptographic Failures",
    category: "crypto",
    issue: "Math.random() used for security-sensitive operation",
    risk: ["Predictable values", "Token/key guessing attacks", "Session hijacking"],
    solution: ["Use crypto.randomBytes()", "Use crypto.randomUUID()", "Use secure random libraries"]
  },
  {
    id: "disabled-ssl",
    title: "SSL/TLS Validation Disabled",
    pattern: /(?:rejectUnauthorized\s*[:=]\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"`]?0|strictSSL\s*[:=]\s*false|secure\s*[:=]\s*false)/i,
    severity: "critical",
    owasp: "A02:2021-Cryptographic Failures",
    category: "crypto",
    issue: "SSL/TLS certificate validation disabled",
    risk: ["Man-in-the-middle attacks", "Credential interception", "Data tampering"],
    solution: ["Enable certificate validation", "Use proper certificates", "Configure trusted CA bundle"]
  },

  // === SECURITY MISCONFIGURATION ===
  {
    id: "cors-wildcard",
    title: "CORS Wildcard Origin",
    pattern: /(?:Access-Control-Allow-Origin|origin)\s*[:=]\s*['"`]\*['"`]|cors\s*\(\s*\)/,
    severity: "medium",
    owasp: "A05:2021-Security Misconfiguration",
    category: "config",
    issue: "CORS allows all origins (*)",
    risk: ["Cross-origin attacks", "Data theft from other domains", "CSRF-like attacks"],
    solution: ["Specify allowed origins explicitly", "Use allowlist for trusted domains", "Implement proper CORS policy"]
  },
  {
    id: "missing-csp",
    title: "Missing Content Security Policy",
    pattern: /helmet\s*\(\s*\)(?!\s*.*contentSecurityPolicy)/,
    severity: "low",
    owasp: "A05:2021-Security Misconfiguration",
    category: "config",
    issue: "Helmet used without explicit CSP configuration",
    risk: ["XSS attacks", "Clickjacking", "Data injection"],
    solution: ["Configure Content-Security-Policy header", "Define script-src, style-src directives", "Use nonces or hashes for inline scripts"]
  },
  {
    id: "debug-enabled",
    title: "Debug Mode in Production",
    pattern: /(?:DEBUG|debug)\s*[:=]\s*(?:true|['"`]true['"`]|1)|app\.set\s*\(\s*['"`](?:env|debug)['"`]\s*,\s*['"`]development['"`]\s*\)/i,
    severity: "medium",
    owasp: "A05:2021-Security Misconfiguration",
    category: "config",
    issue: "Debug mode may be enabled in production",
    risk: ["Information disclosure", "Stack traces exposed", "Performance impact"],
    solution: ["Use environment variables", "Disable debug in production", "Implement proper logging"],
    exclude: /\.env\.development|\.env\.local|test|spec/i
  },
  {
    id: "exposed-stack-trace",
    title: "Stack Trace Exposure",
    pattern: /(?:res\.(?:send|json)|response\.(?:send|json))\s*\([^)]*(?:err\.stack|error\.stack|\.stack)/i,
    severity: "medium",
    owasp: "A09:2021-Logging Failures",
    category: "config",
    issue: "Stack traces may be exposed to clients",
    risk: ["Information disclosure", "Internal structure revealed", "Attack surface mapping"],
    solution: ["Log errors server-side only", "Return generic error messages", "Use error handling middleware"]
  },

  // === SENSITIVE DATA EXPOSURE ===
  {
    id: "logging-sensitive-data",
    title: "Sensitive Data in Logs",
    pattern: /(?:console\.(?:log|info|debug|warn)|logger\.(?:info|debug|warn))\s*\([^)]*(?:password|token|secret|apiKey|creditCard|ssn|authorization)/i,
    severity: "medium",
    owasp: "A09:2021-Logging Failures",
    category: "config",
    issue: "Sensitive data may be logged",
    risk: ["Credential exposure in logs", "Compliance violations (PCI-DSS, GDPR)", "Log file compromise"],
    solution: ["Mask sensitive fields in logs", "Use structured logging with redaction", "Implement log filtering"]
  },
  {
    id: "hardcoded-ip",
    title: "Hardcoded IP/Host",
    pattern: /(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?!\.(?:0|255))/,
    severity: "low",
    owasp: "A05:2021-Security Misconfiguration",
    category: "config",
    issue: "Hardcoded IP address detected",
    risk: ["Environment coupling", "Difficult to maintain", "May expose internal infrastructure"],
    solution: ["Use environment variables", "Use configuration management", "Use DNS names"],
    exclude: /localhost|127\.0\.0\.1|0\.0\.0\.0|test|mock|example/i
  },

  // === MOBILE SECURITY ===
  {
    id: "deep-link-no-validation",
    title: "Deep Link Without Validation",
    pattern: /Linking\.addEventListener|useURL\s*\(\s*\)|Linking\.getInitialURL/,
    severity: "medium",
    owasp: "A04:2021-Insecure Design",
    category: "mobile",
    issue: "Deep link handling detected without visible validation",
    risk: ["Malicious deep links", "URL parameter injection", "Unauthorized actions triggered"],
    solution: ["Validate all deep link parameters", "Implement allowlist for paths", "Sanitize extracted data"]
  },
  {
    id: "cleartext-traffic",
    title: "Cleartext Traffic Allowed",
    pattern: /usesCleartextTraffic\s*[:=]\s*true|cleartextTrafficPermitted\s*[:=]\s*true|NSAllowsArbitraryLoads\s*[:=]\s*true/i,
    severity: "high",
    owasp: "A02:2021-Cryptographic Failures",
    category: "mobile",
    issue: "Cleartext (HTTP) traffic allowed",
    risk: ["Data interception", "Man-in-the-middle attacks", "Credential theft"],
    solution: ["Use HTTPS only", "Implement certificate pinning", "Configure network security properly"]
  },
  {
    id: "webview-javascript",
    title: "WebView JavaScript Enabled",
    pattern: /javaScriptEnabled\s*[:=]\s*true.*(?:source\s*[:=]\s*\{.*uri)|WebView.*javaScriptEnabled/i,
    severity: "medium",
    owasp: "A03:2021-Injection",
    category: "mobile",
    issue: "WebView with JavaScript enabled loading remote content",
    risk: ["XSS in WebView", "Bridge exploitation", "Data theft"],
    solution: ["Validate WebView URLs", "Use allowlist for sources", "Disable JavaScript if not needed", "Implement message validation"]
  },

  // === COOKIE SECURITY ===
  {
    id: "insecure-cookie",
    title: "Insecure Cookie Configuration",
    pattern: /(?:cookie|Cookie).*(?:httpOnly\s*[:=]\s*false|secure\s*[:=]\s*false|sameSite\s*[:=]\s*['"`]none['"`](?!.*secure\s*[:=]\s*true))/i,
    severity: "high",
    owasp: "A01:2021-Broken Access Control",
    category: "auth",
    issue: "Cookie missing security flags",
    risk: ["Session hijacking via XSS", "Cookie theft over HTTP", "CSRF attacks"],
    solution: ["Set httpOnly: true", "Set secure: true", "Set sameSite: 'strict' or 'lax'"]
  },

  // === INPUT VALIDATION ===
  {
    id: "missing-input-validation",
    title: "Missing Input Validation",
    pattern: /req\.(?:body|query|params)\.[\w.]+(?!.*(?:validate|sanitize|escape|parseInt|Number\(|Boolean\(|\.trim\())/,
    severity: "medium",
    owasp: "A03:2021-Injection",
    category: "injection",
    issue: "User input used without apparent validation",
    risk: ["Injection attacks", "Type confusion", "Business logic bypass"],
    solution: ["Validate input types", "Use validation libraries (Joi, Yup, Zod)", "Implement input sanitization"]
  },

  // === RATE LIMITING ===
  {
    id: "no-rate-limiting",
    title: "Missing Rate Limiting",
    pattern: /(?:router|app)\.(?:post|put|patch)\s*\(\s*['"`]\/(?:login|auth|register|forgot|reset|verify)/i,
    severity: "medium",
    owasp: "A04:2021-Insecure Design",
    category: "auth",
    issue: "Authentication endpoint without visible rate limiting",
    risk: ["Brute force attacks", "Credential stuffing", "DoS attacks"],
    solution: ["Implement rate limiting", "Use exponential backoff", "Add CAPTCHA for repeated failures"]
  }
];

// Positive security practice patterns
const POSITIVE_PATTERNS: PositivePattern[] = [
  {
    id: "secure-storage",
    title: "Secure Token Storage",
    pattern: /(?:SecureStore|expo-secure-store|react-native-keychain|Keychain|KeyStore)\.(?:setItem|save|set)/i,
    description: "Uses secure storage for sensitive tokens (iOS Keychain, Android Keystore)"
  },
  {
    id: "parameterized-query",
    title: "Parameterized SQL Queries",
    pattern: /(?:query|execute)\s*\([^)]*,\s*\[[^\]]+\]|(?:\$\d+|\?)\s*(?:,|\))/,
    description: "Uses parameterized queries to prevent SQL injection"
  },
  {
    id: "input-sanitization",
    title: "Input Sanitization",
    pattern: /(?:sanitize|escape|encode|DOMPurify|validator\.|xss\()/i,
    description: "Implements input sanitization for XSS prevention"
  },
  {
    id: "jwt-verification",
    title: "JWT Verification",
    pattern: /(?:verify|decode)\s*\([^)]*(?:audience|issuer|algorithms)/i,
    description: "Proper JWT verification with audience and issuer checks"
  },
  {
    id: "schema-validation",
    title: "Schema Validation",
    pattern: /(?:Joi|yup|zod|ajv|validate)\.\s*(?:object|schema|validate|parse)/i,
    description: "Uses schema validation for request/response validation"
  },
  {
    id: "auth-middleware",
    title: "Authorization Middleware",
    pattern: /(?:requireAuth|isAuthenticated|checkAuth|protect|guard|authenticate)\s*(?:\(|,)/i,
    description: "Pre-handler hooks verify user access to resources"
  },
  {
    id: "url-encoding",
    title: "URL Encoding",
    pattern: /encodeURIComponent\s*\(/,
    description: "Uses encodeURIComponent() for dynamic URL parameters"
  },
  {
    id: "error-boundary",
    title: "Error Boundary",
    pattern: /(?:ErrorBoundary|componentDidCatch|getDerivedStateFromError)/,
    description: "Implements error boundaries to prevent information leakage"
  },
  {
    id: "security-headers",
    title: "Security Headers",
    pattern: /helmet\s*\(|(?:X-Content-Type-Options|X-Frame-Options|Strict-Transport-Security)/i,
    description: "Implements security headers for defense-in-depth"
  },
  {
    id: "rate-limiter",
    title: "Rate Limiting",
    pattern: /(?:rateLimit|rateLimiter|express-rate-limit|slowDown)/i,
    description: "Implements rate limiting to prevent abuse"
  },
  {
    id: "csrf-protection",
    title: "CSRF Protection",
    pattern: /(?:csrf|csurf|xsrf)(?:Token|Protection|Middleware)?/i,
    description: "Implements CSRF protection tokens"
  },
  {
    id: "bcrypt-password",
    title: "Secure Password Hashing",
    pattern: /(?:bcrypt|argon2|scrypt)\.(?:hash|compare)/i,
    description: "Uses strong password hashing algorithm"
  },
  {
    id: "certificate-pinning",
    title: "Certificate Pinning",
    pattern: /(?:pinnedCertificates|certificatePinning|TrustKit|ssl-pinning)/i,
    description: "Implements SSL certificate pinning"
  },
  {
    id: "integrity-check",
    title: "Data Integrity Check",
    pattern: /(?:hmac|signature|verify|checksum).*(?:SHA256|SHA512)/i,
    description: "Implements data integrity verification"
  }
];

// File extensions to analyze
const ANALYZABLE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte",
  ".json", ".yaml", ".yml", ".xml", ".plist",
  ".env", ".config", ".conf"
];

// Files/directories to skip
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist\//,
  /build\//,
  /coverage\//,
  /\.next\//,
  /\.nuxt\//,
  /vendor\//,
  /\.min\./,
  /\.bundle\./,
  /package-lock\.json/,
  /yarn\.lock/,
  /pnpm-lock\.yaml/
];

// ============= ANALYSIS FUNCTIONS =============

/**
 * Recursively get all analyzable files in a directory
 */
async function getAnalyzableFiles(
  dirPath: string,
  include?: string[],
  exclude?: string[]
): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(dirPath, fullPath);

        // Skip patterns
        if (SKIP_PATTERNS.some(pattern => pattern.test(fullPath))) {
          continue;
        }

        // User exclude patterns
        if (exclude?.some(pattern => {
          const regex = new RegExp(pattern.replace(/\*/g, ".*"));
          return regex.test(relativePath);
        })) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();

          // Check include patterns
          if (include?.length) {
            const matches = include.some(pattern => {
              const regex = new RegExp(pattern.replace(/\*/g, ".*"));
              return regex.test(relativePath);
            });
            if (!matches) continue;
          }

          if (ANALYZABLE_EXTENSIONS.includes(ext) || entry.name.startsWith(".env")) {
            files.push(fullPath);
          }
        }
      }
    } catch (err) {
      // Skip unreadable directories
    }
  }

  await walk(dirPath);
  return files;
}

/**
 * Analyze a single file for security vulnerabilities
 */
async function analyzeFile(
  filePath: string,
  basePath: string,
  focusAreas?: string[]
): Promise<{
  vulnerabilities: SecurityVulnerability[];
  positivePractices: PositiveSecurityPractice[];
  isSecurityRelated: boolean;
  hasErrorBoundary: boolean;
  secureStorageOps: number;
}> {
  const vulnerabilities: SecurityVulnerability[] = [];
  const positivePractices: PositiveSecurityPractice[] = [];
  let isSecurityRelated = false;
  let hasErrorBoundary = false;
  let secureStorageOps = 0;

  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);
    const relativePath = path.relative(basePath, filePath);
    const ext = path.extname(filePath).toLowerCase();

    // Check for security-related file
    const securityKeywords = /auth|security|crypt|token|session|login|password|secret|key|cert|ssl|tls/i;
    if (securityKeywords.test(relativePath) || securityKeywords.test(content.slice(0, 2000))) {
      isSecurityRelated = true;
    }

    // Check vulnerability patterns
    let vulnId = 0;
    for (const pattern of VULNERABILITY_PATTERNS) {
      // Filter by focus areas
      if (focusAreas?.length && !focusAreas.includes(pattern.category)) {
        continue;
      }

      // Check file type restrictions
      if (pattern.fileTypes && !pattern.fileTypes.includes(ext)) {
        continue;
      }

      // Search through lines
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Skip if line matches exclude pattern
        if (pattern.exclude && pattern.exclude.test(line)) {
          continue;
        }

        if (pattern.pattern.test(line)) {
          vulnId++;
          vulnerabilities.push({
            id: vulnId,
            title: pattern.title,
            severity: pattern.severity,
            owasp: pattern.owasp,
            status: pattern.severity === "low" ? "review" : "needs-fix",
            location: {
              file: relativePath,
              line: i + 1,
              snippet: line.trim().slice(0, 100)
            },
            issue: pattern.issue,
            risk: pattern.risk,
            solution: pattern.solution
          });
          break; // One finding per pattern per file
        }
      }
    }

    // Check positive patterns
    for (const pattern of POSITIVE_PATTERNS) {
      // Check file type restrictions
      if (pattern.fileTypes && !pattern.fileTypes.includes(ext)) {
        continue;
      }

      for (let i = 0; i < lines.length; i++) {
        if (pattern.pattern.test(lines[i])) {
          positivePractices.push({
            title: pattern.title,
            description: pattern.description,
            location: {
              file: relativePath,
              line: i + 1
            }
          });

          // Count specific patterns
          if (pattern.id === "error-boundary") {
            hasErrorBoundary = true;
          }
          if (pattern.id === "secure-storage") {
            secureStorageOps++;
          }
          break; // One finding per pattern per file
        }
      }
    }

  } catch (err) {
    // Skip unreadable files
  }

  return {
    vulnerabilities,
    positivePractices,
    isSecurityRelated,
    hasErrorBoundary,
    secureStorageOps
  };
}

/**
 * Analyze content directly (for PR review integration)
 * @param content - File content to analyze
 * @param filePath - File path (for context, doesn't need to exist on disk)
 * @param focusAreas - Optional areas to focus on
 */
export function analyzeContentSecurity(
  content: string,
  filePath: string,
  focusAreas?: string[]
): {
  vulnerabilities: SecurityVulnerability[];
  positivePractices: PositiveSecurityPractice[];
} {
  const vulnerabilities: SecurityVulnerability[] = [];
  const positivePractices: PositiveSecurityPractice[] = [];

  const lines = content.split(/\r?\n/);
  const ext = path.extname(filePath).toLowerCase();

  // Check vulnerability patterns
  let vulnId = 0;
  for (const pattern of VULNERABILITY_PATTERNS) {
    // Filter by focus areas
    if (focusAreas?.length && !focusAreas.includes(pattern.category)) {
      continue;
    }

    // Check file type restrictions
    if (pattern.fileTypes && !pattern.fileTypes.includes(ext)) {
      continue;
    }

    // Search through lines
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip if line matches exclude pattern
      if (pattern.exclude && pattern.exclude.test(line)) {
        continue;
      }

      if (pattern.pattern.test(line)) {
        vulnId++;
        vulnerabilities.push({
          id: vulnId,
          title: pattern.title,
          severity: pattern.severity,
          owasp: pattern.owasp,
          status: pattern.severity === "low" ? "review" : "needs-fix",
          location: {
            file: filePath,
            line: i + 1,
            snippet: line.trim().slice(0, 100)
          },
          issue: pattern.issue,
          risk: pattern.risk,
          solution: pattern.solution
        });
        break; // One finding per pattern per file
      }
    }
  }

  // Check positive patterns
  for (const pattern of POSITIVE_PATTERNS) {
    // Check file type restrictions
    if (pattern.fileTypes && !pattern.fileTypes.includes(ext)) {
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      if (pattern.pattern.test(lines[i])) {
        positivePractices.push({
          title: pattern.title,
          description: pattern.description,
          location: {
            file: filePath,
            line: i + 1
          }
        });
        break; // One finding per pattern per file
      }
    }
  }

  return { vulnerabilities, positivePractices };
}

/**
 * Deduplicate positive practices (keep unique by title)
 */
function deduplicatePositivePractices(
  practices: PositiveSecurityPractice[]
): PositiveSecurityPractice[] {
  const seen = new Map<string, PositiveSecurityPractice>();

  for (const practice of practices) {
    if (!seen.has(practice.title)) {
      seen.set(practice.title, practice);
    }
  }

  return Array.from(seen.values());
}

/**
 * Generate recommendations based on findings
 */
function generateRecommendations(
  vulnerabilities: SecurityVulnerability[],
  positivePractices: PositiveSecurityPractice[]
): { priority: "immediate" | "high" | "medium" | "ongoing"; description: string }[] {
  const recommendations: { priority: "immediate" | "high" | "medium" | "ongoing"; description: string }[] = [];

  // Immediate priorities (critical severity)
  const critical = vulnerabilities.filter(v => v.severity === "critical");
  if (critical.length > 0) {
    const titles = [...new Set(critical.map(v => v.title))];
    recommendations.push({
      priority: "immediate",
      description: `Fix ${critical.length} critical issue${critical.length > 1 ? "s" : ""}: ${titles.join(", ")}`
    });
  }

  // High priorities
  const high = vulnerabilities.filter(v => v.severity === "high");
  if (high.length > 0) {
    const titles = [...new Set(high.map(v => v.title))];
    recommendations.push({
      priority: "high",
      description: `Address ${high.length} high-severity issue${high.length > 1 ? "s" : ""}: ${titles.join(", ")}`
    });
  }

  // Medium priorities
  const medium = vulnerabilities.filter(v => v.severity === "medium");
  if (medium.length > 0) {
    recommendations.push({
      priority: "medium",
      description: `Review ${medium.length} medium-severity finding${medium.length > 1 ? "s" : ""} for potential fixes`
    });
  }

  // Ongoing recommendations based on missing positive practices
  const hasSecureStorage = positivePractices.some(p => p.title.includes("Secure") && p.title.includes("Storage"));
  const hasRateLimiting = positivePractices.some(p => p.title.includes("Rate Limiting"));
  const hasCertPinning = positivePractices.some(p => p.title.includes("Certificate Pinning"));

  if (!hasSecureStorage) {
    recommendations.push({
      priority: "ongoing",
      description: "Consider implementing secure storage for sensitive tokens"
    });
  }
  if (!hasRateLimiting) {
    recommendations.push({
      priority: "ongoing",
      description: "Implement rate limiting for API endpoints"
    });
  }
  if (!hasCertPinning) {
    recommendations.push({
      priority: "ongoing",
      description: "Consider adding certificate pinning for production API domains"
    });
  }

  // Add general security recommendation
  recommendations.push({
    priority: "ongoing",
    description: "Implement automated security scanning in CI/CD pipeline"
  });

  return recommendations;
}

// ============= MAIN EXPORT =============

/**
 * Perform comprehensive security analysis on a codebase
 */
export async function analyzeSecurityComprehensive(
  targetPath: string,
  options?: {
    include?: string[];
    exclude?: string[];
    focus?: string[];
    minSeverity?: SecuritySeverity;
  }
): Promise<SecurityAnalysisResponse> {
  // Normalize path
  const basePath = path.resolve(targetPath);

  // Get all analyzable files
  const files = await getAnalyzableFiles(basePath, options?.include, options?.exclude);

  // Analyze each file
  const allVulnerabilities: SecurityVulnerability[] = [];
  const allPositivePractices: PositiveSecurityPractice[] = [];
  let securityRelatedFiles = 0;
  let errorBoundaries = 0;
  let totalSecureStorageOps = 0;

  for (const file of files) {
    const result = await analyzeFile(file, basePath, options?.focus);

    allVulnerabilities.push(...result.vulnerabilities);
    allPositivePractices.push(...result.positivePractices);

    if (result.isSecurityRelated) securityRelatedFiles++;
    if (result.hasErrorBoundary) errorBoundaries++;
    totalSecureStorageOps += result.secureStorageOps;
  }

  // Renumber vulnerabilities
  allVulnerabilities.forEach((v, i) => v.id = i + 1);

  // Filter by minimum severity if specified
  const severityOrder: SecuritySeverity[] = ["low", "medium", "high", "critical"];
  let filteredVulnerabilities = allVulnerabilities;

  if (options?.minSeverity) {
    const minIdx = severityOrder.indexOf(options.minSeverity);
    filteredVulnerabilities = allVulnerabilities.filter(v =>
      severityOrder.indexOf(v.severity) >= minIdx
    );
  }

  // Deduplicate positive practices
  const uniquePositivePractices = deduplicatePositivePractices(allPositivePractices);

  // Calculate summary
  const summary = {
    critical: filteredVulnerabilities.filter(v => v.severity === "critical").length,
    high: filteredVulnerabilities.filter(v => v.severity === "high").length,
    medium: filteredVulnerabilities.filter(v => v.severity === "medium").length,
    low: filteredVulnerabilities.filter(v => v.severity === "low").length,
    total: filteredVulnerabilities.length
  };

  // Generate recommendations
  const recommendations = generateRecommendations(filteredVulnerabilities, uniquePositivePractices);

  // Build metrics
  const metrics: SecurityMetrics = {
    totalFilesAnalyzed: files.length,
    securityRelatedFiles,
    errorBoundaries,
    secureStorageOps: totalSecureStorageOps,
    totalPatternsDetected: uniquePositivePractices.length,
    antiPatternsFound: filteredVulnerabilities.length
  };

  return {
    vulnerabilities: filteredVulnerabilities,
    positivePractices: uniquePositivePractices,
    metrics,
    summary,
    recommendations
  };
}
