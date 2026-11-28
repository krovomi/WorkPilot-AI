/**
 * A local model server for the Electron E2E specs, speaking the part of
 * Ollama's HTTP API the app and the backend use: `/api/tags` (the models
 * installed), `/api/show`, `/api/chat` (one completion, NDJSON) and
 * `/api/embed` (embeddings). The app is pointed at it with the Ollama
 * provider and its base URL, so every one-shot completion of the real
 * backend (`runners/oneshot_completion_runner.py`, `LocalAgentClient`) and
 * every embeddings call (`board_ask_embed_runner.py`) reaches this process
 * instead of a model: no network, no account.
 *
 * What it answers is the spec's: `chat` reads the prompt and returns the
 * text, `embed` turns a text into a vector. Every request is kept, so a spec
 * can check what the app sent to the model.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The chat model the server lists, as `ollama list` shows it. */
export const CHAT_MODEL = "llama3.3:latest";
/** The embeddings model it lists: multilingual, the one the board picks first. */
export const EMBED_MODEL = "bge-m3:latest";

export interface ChatRequest {
	model: string;
	system: string;
	/** The user turn: the prompt the app built. */
	prompt: string;
}

/** A chat answer: the model's text, or an HTTP failure of the server. */
export type ChatReply = string | { status: number };

export interface FakeOllama {
	/** `http://127.0.0.1:<port>`, what the app takes as its Ollama URL. */
	url: string;
	/** Every chat request, oldest first. */
	chats: ChatRequest[];
	/** Every text sent for embeddings, oldest first. */
	embedded: string[];
	/** Answers a chat request; replace it to change the model's behaviour. */
	chat: (request: ChatRequest) => ChatReply;
	/** A text's embedding; null makes the server fail the whole batch. */
	embed: ((text: string) => number[]) | null;
	close: () => Promise<void>;
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf-8");
	if (!text) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function messageText(messages: unknown, role: string): string {
	if (!Array.isArray(messages)) return "";
	return messages
		.filter((m) => m && typeof m === "object" && (m as { role?: unknown }).role === role)
		.map((m) => String((m as { content?: unknown }).content ?? ""))
		.join("\n");
}

export async function startFakeOllama(): Promise<FakeOllama> {
	const fake: FakeOllama = {
		url: "",
		chats: [],
		embedded: [],
		chat: () => ({ status: 503 }),
		embed: null,
		close: async () => undefined,
	};
	const server: Server = createServer((request, response) => {
		const send = (status: number, value: unknown) => {
			response.writeHead(status, { "Content-Type": "application/json" });
			response.end(JSON.stringify(value));
		};
		void (async () => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const payload = request.method === "POST" ? await body(request) : {};
			switch (url.pathname) {
				case "/api/version":
					return send(200, { version: "0.12.0" });
				case "/api/tags":
				case "/api/ps":
					return send(200, {
						models: [CHAT_MODEL, EMBED_MODEL].map((name) => ({ name, model: name, size: 1 })),
					});
				case "/api/show":
					return send(200, { capabilities: ["completion"], model_info: {} });
				case "/api/chat": {
					const chat: ChatRequest = {
						model: String(payload.model ?? ""),
						system: messageText(payload.messages, "system"),
						prompt: messageText(payload.messages, "user"),
					};
					fake.chats.push(chat);
					const reply = fake.chat(chat);
					if (typeof reply !== "string") return send(reply.status, { error: "unavailable" });
					// One NDJSON object with the whole text, as Ollama ends a stream.
					response.writeHead(200, { "Content-Type": "application/x-ndjson" });
					response.end(
						`${JSON.stringify({
							model: chat.model,
							message: { role: "assistant", content: reply },
							done: true,
							done_reason: "stop",
							prompt_eval_count: Math.ceil(chat.prompt.length / 4),
							eval_count: Math.ceil(reply.length / 4),
						})}\n`,
					);
					return;
				}
				case "/api/embed": {
					const input = Array.isArray(payload.input) ? payload.input.map(String) : [String(payload.input ?? "")];
					fake.embedded.push(...input);
					const embed = fake.embed;
					if (!embed) return send(500, { error: "no embeddings model loaded" });
					return send(200, { model: String(payload.model ?? EMBED_MODEL), embeddings: input.map(embed) });
				}
				default:
					return send(404, { error: "not found" });
			}
		})().catch(() => send(500, { error: "fake server failure" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
	return fake;
}
