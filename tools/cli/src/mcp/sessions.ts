import type { HarnessSession } from "../harness.js";

export interface SessionRecord {
	id: string;
	session: HarnessSession;
}

const MAX_SESSIONS = 8;
const sessions = new Map<string, SessionRecord>();
let counter = 0;

export function addSession(session: HarnessSession): SessionRecord {
	if (sessions.size >= MAX_SESSIONS) {
		throw new Error(`session limit reached (${MAX_SESSIONS}) — unload a host with xript_host_unload first`);
	}
	const id = `host-${++counter}`;
	const record = { id, session };
	sessions.set(id, record);
	return record;
}

export function getSession(id: string): SessionRecord | undefined {
	return sessions.get(id);
}

export function removeSession(id: string): boolean {
	const record = sessions.get(id);
	if (!record) return false;
	record.session.dispose();
	sessions.delete(id);
	return true;
}

export function listSessions(): Array<{ id: string; host: string }> {
	return [...sessions.values()].map((record) => ({ id: record.id, host: record.session.summary.host }));
}
