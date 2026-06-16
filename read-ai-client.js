// Read.AI OAuth 2.1 client — manages access_token refresh with rotation
// Refresh tokens rotate on every use; we persist the latest one in memory
// AND optionally to disk (or env, for Render restart resilience).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN_ENDPOINT = 'https://authn.read.ai/oauth2/token';
const API_BASE = 'https://api.read.ai';

export class ReadAIClient {
  constructor({ clientId, clientSecret, initialRefreshToken, persistPath }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = initialRefreshToken;
    this.persistPath = persistPath || path.join(__dirname, '.read-ai-state.json');
    this.accessToken = null;
    this.accessExpiresAt = 0;
    this.refreshPromise = null;  // dedupe concurrent refreshes
    // try restore from disk (covers Render redeploy)
    this._restored = this._tryRestore();
  }

  async _tryRestore() {
    try {
      const raw = await fs.readFile(this.persistPath, 'utf8');
      const data = JSON.parse(raw);
      if (data.refreshToken) this.refreshToken = data.refreshToken;
      if (data.accessToken && data.accessExpiresAt > Date.now() + 30_000) {
        this.accessToken = data.accessToken;
        this.accessExpiresAt = data.accessExpiresAt;
      }
    } catch {}
  }

  async _persist() {
    try {
      await fs.writeFile(this.persistPath, JSON.stringify({
        refreshToken: this.refreshToken,
        accessToken: this.accessToken,
        accessExpiresAt: this.accessExpiresAt,
        updatedAt: Date.now(),
      }, null, 2));
    } catch (e) {
      console.warn('[readai] persist failed:', e.message);
    }
  }

  async _refresh() {
    if (!this.refreshToken) throw new Error('readai: no refresh token configured');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
    });
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const r = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${basic}`,
      },
      body,
    });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`readai refresh failed ${r.status}: ${txt}`);
    }
    const data = await r.json();
    this.accessToken = data.access_token;
    // Read.AI rotates refresh_token on every use
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    const expiresIn = Number(data.expires_in || 600);
    this.accessExpiresAt = Date.now() + (expiresIn * 1000);
    await this._persist();
    return this.accessToken;
  }

  async getAccessToken() {
    await this._restored;
    if (this.accessToken && this.accessExpiresAt > Date.now() + 30_000) {
      return this.accessToken;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this._refresh().finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }

  async call(path, { query, expand } = {}) {
    const token = await this.getAccessToken();
    const url = new URL(API_BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, v);
    }
    if (expand && expand.length) for (const f of expand) url.searchParams.append('expand[]', f);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`readai ${path} ${r.status}: ${txt.slice(0, 400)}`);
    }
    return r.json();
  }

  // ============= High-level helpers =============

  async listMeetings({ limit = 10, startGte, startLte, cursor, expand } = {}) {
    return this.call('/v1/meetings', {
      query: {
        limit,
        'start_time_ms.gte': startGte,
        'start_time_ms.lte': startLte,
        cursor,
      },
      expand,
    });
  }

  async getMeeting(id, expand = ['summary', 'metrics']) {
    return this.call(`/v1/meetings/${id}`, { expand });
  }

  async getLiveMeeting(id, expand = ['transcript']) {
    return this.call(`/v1/meetings/${id}/live`, { expand });
  }

  // Pages through all meetings within a time window, returning a flat list.
  // Soft-bounded by maxPages to avoid runaway costs.
  async listAllMeetings({ startGte, startLte, expand, maxPages = 10 } = {}) {
    const out = [];
    let cursor = null;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.listMeetings({ limit: 10, startGte, startLte, cursor, expand });
      out.push(...(page.data || []));
      if (!page.has_more || !page.data?.length) break;
      cursor = page.data[page.data.length - 1].id;
    }
    return out;
  }
}
