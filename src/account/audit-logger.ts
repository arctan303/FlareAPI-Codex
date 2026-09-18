import { GatewayError } from "../errors";
import { readJsonBody } from "../protocol/requests";
import {
  captureJson,
  DEFAULT_LOG_SETTINGS,
  StreamBodyCapture,
  validateLogSettingsPatch
} from "../observability";
import type { AccountStorage } from "../runtime/contracts";
import type {
  GatewayIdentity,
  LogSettings,
  RequestLogOutcome,
  RequestLogSummary,
  RequestLogUsage
} from "../types";

export const LOG_SETTINGS_KEY = "log-settings";
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_LOG_ROWS = 5_000;
const REQUEST_GROUP_TTL_MS = GENERATION_TIMEOUT_MS + 5_000;
const ALARM_RETRY_MS = 60_000;
export const EMPTY_USAGE: RequestLogUsage = { inputTokens: null, outputTokens: null, totalTokens: null };

export interface ActiveLog {
  id: string;
  settings: LogSettings;
  responseCapture: StreamBodyCapture | null;
  outcome: RequestLogOutcome;
  usage: RequestLogUsage;
  httpStatus: number | null;
}

export function gatewayStatus(error: unknown): number {
  return error instanceof GatewayError ? error.status : 500;
}

export function gatewayOutcome(error: unknown): RequestLogOutcome {
  return error instanceof GatewayError && (error.code === "request_cancelled" || error.status === 499) ? "cancelled" : "error";
}

export function captureStreamBody(stream: ReadableStream<Uint8Array>, capture: StreamBodyCapture): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else {
          capture.append(next.value);
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    }
  });
}

export class AuditLogger {
  constructor(private readonly storage: AccountStorage) {}

  async init(): Promise<void> {
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      key_name TEXT NOT NULL,
      protocol TEXT NOT NULL,
      model TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER,
      http_status INTEGER,
      outcome TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      body_captured INTEGER NOT NULL,
      request_truncated INTEGER NOT NULL,
      response_truncated INTEGER NOT NULL,
      request_body TEXT,
      response_body TEXT,
      body_expires_at INTEGER,
      ignored_parameters TEXT NOT NULL DEFAULT '[]'
    )`);
    const requestLogColumns = this.storage.sql.exec<{ name: string }>("PRAGMA table_info(request_logs)").toArray();
    if (!requestLogColumns.some((column) => column.name === "ignored_parameters")) {
      this.storage.sql.exec("ALTER TABLE request_logs ADD COLUMN ignored_parameters TEXT NOT NULL DEFAULT '[]'");
    }
    this.storage.sql.exec("CREATE INDEX IF NOT EXISTS request_logs_started_idx ON request_logs(started_at DESC)");
    this.storage.sql.exec("CREATE INDEX IF NOT EXISTS request_logs_key_idx ON request_logs(key_id, started_at DESC)");
    await this.scheduleLogAlarmSafely();
  }

  async logSettings(): Promise<LogSettings> {
    const stored = await this.storage.get<Partial<LogSettings>>(LOG_SETTINGS_KEY);
    return {
      summaryRetentionDays: typeof stored?.summaryRetentionDays === "number" ? stored.summaryRetentionDays : DEFAULT_LOG_SETTINGS.summaryRetentionDays,
      bodyRetentionDays: typeof stored?.bodyRetentionDays === "number" ? stored.bodyRetentionDays : DEFAULT_LOG_SETTINGS.bodyRetentionDays,
      captureBodies: stored?.captureBodies === true,
      maxBodyBytes: typeof stored?.maxBodyBytes === "number" ? stored.maxBodyBytes : DEFAULT_LOG_SETTINGS.maxBodyBytes
    };
  }

  async getLogSettings(): Promise<Response> {
    return Response.json(await this.logSettings(), { headers: { "Cache-Control": "no-store" } });
  }

  async patchLogSettings(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const next = validateLogSettingsPatch(body, await this.logSettings());
    await this.storage.put(LOG_SETTINGS_KEY, next);
    this.pruneLogs(next);
    await this.scheduleLogAlarmSafely(next);
    return Response.json(next, { headers: { "Cache-Control": "no-store" } });
  }

  pruneLogs(settings: LogSettings): void {
    const now = Date.now();
    const summaryCutoff = now - settings.summaryRetentionDays * 24 * 60 * 60 * 1000;
    const bodyTtlMs = settings.bodyRetentionDays * 24 * 60 * 60 * 1000;
    const orphanCutoff = now - GENERATION_TIMEOUT_MS - 5_000;
    this.storage.sql.exec(
      "UPDATE request_logs SET completed_at = ?, duration_ms = ? - started_at, outcome = 'incomplete' WHERE completed_at IS NULL AND started_at < ?",
      now,
      now,
      orphanCutoff
    );
    this.storage.sql.exec("DELETE FROM request_logs WHERE completed_at IS NOT NULL AND started_at < ?", summaryCutoff);
    this.storage.sql.exec(
      "DELETE FROM request_logs WHERE completed_at IS NOT NULL AND id IN (SELECT id FROM request_logs WHERE completed_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?)",
      MAX_LOG_ROWS
    );
    this.storage.sql.exec(
      "UPDATE request_logs SET body_expires_at = CASE " +
      "WHEN body_expires_at IS NULL OR body_expires_at > started_at + ? THEN started_at + ? " +
      "ELSE body_expires_at END " +
      "WHERE body_captured = 1 AND (request_body IS NOT NULL OR response_body IS NOT NULL)",
      bodyTtlMs,
      bodyTtlMs
    );
    this.storage.sql.exec(
      "UPDATE request_logs SET request_body = NULL, response_body = NULL " +
      "WHERE body_captured = 1 AND (request_body IS NOT NULL OR response_body IS NOT NULL) AND body_expires_at <= ?",
      now
    );
  }

  async scheduleLogAlarm(settings?: LogSettings): Promise<void> {
    settings ??= await this.logSettings();
    const summaryTtlMs = settings.summaryRetentionDays * 24 * 60 * 60 * 1000;
    const bodyTtlMs = settings.bodyRetentionDays * 24 * 60 * 60 * 1000;
    const deadlines: number[] = [];
    const addDeadline = (value: number | null | undefined) => {
      if (typeof value === "number" && Number.isFinite(value)) deadlines.push(value);
    };
    addDeadline(this.storage.sql.exec<{ deadline: number | null }>(
      "SELECT MIN(CASE WHEN body_expires_at IS NULL OR body_expires_at > started_at + ? " +
      "THEN started_at + ? ELSE body_expires_at END) AS deadline " +
      "FROM request_logs WHERE body_captured = 1 AND (request_body IS NOT NULL OR response_body IS NOT NULL)",
      bodyTtlMs,
      bodyTtlMs
    ).toArray()[0]?.deadline);
    const summaryStart = this.storage.sql.exec<{ startedAt: number | null }>(
      "SELECT MIN(started_at) AS startedAt FROM request_logs WHERE completed_at IS NOT NULL"
    ).toArray()[0]?.startedAt;
    if (typeof summaryStart === "number") addDeadline(summaryStart + summaryTtlMs);
    const activeStart = this.storage.sql.exec<{ startedAt: number | null }>(
      "SELECT MIN(started_at) AS startedAt FROM request_logs WHERE completed_at IS NULL"
    ).toArray()[0]?.startedAt;
    if (typeof activeStart === "number") addDeadline(activeStart + REQUEST_GROUP_TTL_MS);
    if (deadlines.length === 0) {
      await this.storage.deleteAlarm();
      return;
    }
    await this.storage.setAlarm(Math.max(Date.now() + 1_000, Math.min(...deadlines)));
  }

  async scheduleLogAlarmSafely(settings?: LogSettings): Promise<void> {
    try {
      await this.scheduleLogAlarm(settings);
    } catch {
      console.warn(JSON.stringify({ event: "request_log_alarm_failed", stage: "schedule" }));
      try {
        await this.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
      } catch {
        console.warn(JSON.stringify({ event: "request_log_alarm_failed", stage: "retry" }));
      }
    }
  }

  async alarm(): Promise<void> {
    try {
      const settings = await this.logSettings();
      this.pruneLogs(settings);
      await this.scheduleLogAlarm(settings);
    } catch {
      console.warn(JSON.stringify({ event: "request_log_alarm_failed", stage: "run" }));
      try {
        await this.storage.setAlarm(Date.now() + ALARM_RETRY_MS);
      } catch {
        console.warn(JSON.stringify({ event: "request_log_alarm_failed", stage: "retry" }));
      }
    }
  }

  async startRequestLog(
    identity: GatewayIdentity,
    protocol: "responses" | "chat",
    model: string,
    requestId: string,
    requestBody: Record<string, unknown>,
    ignoredParameters: string[]
  ): Promise<ActiveLog | null> {
    try {
      const settings = await this.logSettings();
      this.pruneLogs(settings);
      const startedAt = Date.now();
      const captured = settings.captureBodies ? captureJson(requestBody, settings.maxBodyBytes) : { body: null, truncated: false };
      const id = crypto.randomUUID();
      this.storage.sql.exec(
        `INSERT INTO request_logs (
          id, request_id, key_id, key_name, protocol, model, started_at, completed_at, duration_ms,
          http_status, outcome, input_tokens, output_tokens, total_tokens, body_captured,
          request_truncated, response_truncated, request_body, response_body, body_expires_at, ignored_parameters
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'incomplete', NULL, NULL, NULL, ?, ?, 0, ?, NULL, ?, ?)`,
        id,
        requestId,
        identity.id,
        identity.name,
        protocol,
        model,
        startedAt,
        settings.captureBodies ? 1 : 0,
        captured.truncated ? 1 : 0,
        captured.body === null ? null : JSON.stringify(captured.body),
        settings.captureBodies ? startedAt + settings.bodyRetentionDays * 24 * 60 * 60 * 1000 : null,
        JSON.stringify(ignoredParameters)
      );
      await this.scheduleLogAlarmSafely(settings);
      return {
        id,
        settings,
        responseCapture: null,
        outcome: "incomplete",
        usage: { ...EMPTY_USAGE },
        httpStatus: null
      };
    } catch (error) {
      console.warn(JSON.stringify({ event: "request_log_write_failed", stage: "start" }));
      return null;
    }
  }

  async finishRequestLog(active: ActiveLog | null, responseBody?: unknown): Promise<void> {
    if (!active) return;
    try {
      const rows = this.storage.sql.exec<Record<string, string | number | null>>(
        "SELECT started_at AS startedAt, completed_at AS completedAt, body_expires_at AS bodyExpiresAt FROM request_logs WHERE id = ?",
        active.id
      ).toArray();
      const stored = rows[0];
      if (!stored || stored.completedAt !== null) return;
      const completedAt = Date.now();
      const currentSettings = await this.logSettings();
      const storedBodyExpiry = stored.bodyExpiresAt === null ? null : Number(stored.bodyExpiresAt);
      const currentBodyExpiry = Number(stored.startedAt) + currentSettings.bodyRetentionDays * 24 * 60 * 60 * 1000;
      const effectiveBodyExpiry = storedBodyExpiry === null ? null : Math.min(storedBodyExpiry, currentBodyExpiry);
      const bodyRetained = active.settings.captureBodies
        && effectiveBodyExpiry !== null
        && effectiveBodyExpiry > completedAt;
      let captured = { body: null as Record<string, unknown> | null, truncated: false };
      if (bodyRetained) {
        captured = active.responseCapture
          ? { body: active.responseCapture.body(), truncated: active.responseCapture.truncated }
          : captureJson(responseBody, active.settings.maxBodyBytes);
      }
      this.storage.sql.exec(
        `UPDATE request_logs SET completed_at = ?, duration_ms = ?, http_status = ?, outcome = ?,
          input_tokens = ?, output_tokens = ?, total_tokens = ?, response_truncated = ?, response_body = ?, body_expires_at = ?
          WHERE id = ?`,
        completedAt,
        Math.max(0, completedAt - Number(stored.startedAt)),
        active.httpStatus,
        active.outcome,
        active.usage.inputTokens,
        active.usage.outputTokens,
        active.usage.totalTokens,
        captured.truncated ? 1 : 0,
        captured.body === null ? null : JSON.stringify(captured.body),
        effectiveBodyExpiry,
        active.id
      );
      await this.scheduleLogAlarmSafely(currentSettings);
    } catch (error) {
      console.warn(JSON.stringify({ event: "request_log_write_failed", stage: "finish" }));
    }
  }

  private logSummary(row: Record<string, string | number | null>): RequestLogSummary {
    let ignoredParameters: string[] = [];
    if (typeof row.ignoredParameters === "string") {
      try {
        const parsed = JSON.parse(row.ignoredParameters) as unknown;
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) ignoredParameters = [...new Set(parsed)];
      } catch {}
    }
    return {
      id: String(row.id),
      requestId: String(row.requestId),
      keyId: String(row.keyId),
      keyName: String(row.keyName),
      protocol: row.protocol === "chat" ? "chat" : "responses",
      model: String(row.model),
      startedAt: Number(row.startedAt),
      completedAt: row.completedAt === null ? null : Number(row.completedAt),
      durationMs: row.durationMs === null ? null : Number(row.durationMs),
      httpStatus: row.httpStatus === null ? null : Number(row.httpStatus),
      outcome: String(row.outcome) as RequestLogOutcome,
      usage: {
        inputTokens: row.inputTokens === null ? null : Number(row.inputTokens),
        outputTokens: row.outputTokens === null ? null : Number(row.outputTokens),
        totalTokens: row.totalTokens === null ? null : Number(row.totalTokens)
      },
      bodyCaptured: row.bodyCaptured === 1,
      bodyExpired: row.bodyCaptured === 1 && row.bodyExpiresAt !== null && Number(row.bodyExpiresAt) <= Date.now(),
      requestTruncated: row.requestTruncated === 1,
      responseTruncated: row.responseTruncated === 1,
      ignoredParameters
    };
  }

  private logSelect(): string {
    return `SELECT id, request_id AS requestId, key_id AS keyId, key_name AS keyName, protocol, model,
      started_at AS startedAt, completed_at AS completedAt, duration_ms AS durationMs, http_status AS httpStatus,
      outcome, input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens,
      body_captured AS bodyCaptured, body_expires_at AS bodyExpiresAt,
      request_truncated AS requestTruncated, response_truncated AS responseTruncated,
      ignored_parameters AS ignoredParameters
      FROM request_logs`;
  }

  async listLogs(url: URL): Promise<Response> {
    const settings = await this.logSettings();
    this.pruneLogs(settings);
    await this.scheduleLogAlarmSafely(settings);
    const keyId = url.searchParams.get("keyId");
    const model = url.searchParams.get("model");
    const outcome = url.searchParams.get("outcome");
    if (outcome && !["completed", "error", "cancelled", "incomplete"].includes(outcome)) {
      throw new GatewayError(400, "invalid_log_filter", "outcome 筛选值无效。", "outcome");
    }
    const integerQuery = (name: string): number | null => {
      const raw = url.searchParams.get(name);
      if (raw === null) return null;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) throw new GatewayError(400, "invalid_log_filter", `${name} 必须是非负整数毫秒时间戳。`, name);
      return value;
    };
    const from = integerQuery("from");
    const to = integerQuery("to");
    if (from !== null && to !== null && from > to) throw new GatewayError(400, "invalid_log_filter", "from 不得晚于 to。", "from");
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new GatewayError(400, "invalid_log_filter", "limit 必须是 1 到 100 的整数。", "limit");
    const rawCursor = url.searchParams.get("cursor");
    const offset = rawCursor === null ? 0 : Number(rawCursor);
    if (!Number.isInteger(offset) || offset < 0) throw new GatewayError(400, "invalid_log_filter", "cursor 无效。", "cursor");

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (keyId) { where.push("key_id = ?"); params.push(keyId); }
    if (model) { where.push("model = ?"); params.push(model); }
    if (outcome) { where.push("outcome = ?"); params.push(outcome); }
    if (from !== null) { where.push("started_at >= ?"); params.push(from); }
    if (to !== null) { where.push("started_at <= ?"); params.push(to); }
    const query = `${this.logSelect()} ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`;
    const rows = this.storage.sql.exec<Record<string, string | number | null>>(query, ...params, limit + 1, offset).toArray();
    const hasNext = rows.length > limit;
    const data = rows.slice(0, limit).map((row) => this.logSummary(row));
    return Response.json({ data, nextCursor: hasNext ? String(offset + limit) : null }, {
      headers: { "Cache-Control": "no-store" }
    });
  }

  async getLog(id: string): Promise<Response> {
    const settings = await this.logSettings();
    this.pruneLogs(settings);
    await this.scheduleLogAlarmSafely(settings);
    const rows = this.storage.sql.exec<Record<string, string | number | null>>(
      this.logSelect().replace(
        " FROM request_logs",
        ", request_body AS requestBody, response_body AS responseBody FROM request_logs"
      ) + " WHERE id = ?",
      id
    ).toArray();
    const row = rows[0];
    if (!row) throw new GatewayError(404, "request_log_not_found", "没有找到该调用日志。", "id");
    const parseBody = (value: string | number | null): Record<string, unknown> | null => {
      if (typeof value !== "string") return null;
      try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
      } catch {
        return { unavailable: true };
      }
    };
    return Response.json({
      ...this.logSummary(row),
      requestBody: parseBody(row.requestBody),
      responseBody: parseBody(row.responseBody),
      bodyExpiresAt: row.bodyExpiresAt === null ? null : Number(row.bodyExpiresAt)
    }, { headers: { "Cache-Control": "no-store" } });
  }
}
