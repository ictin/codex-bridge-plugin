function extractPeerId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "unknown";
  if (value.startsWith("tg:")) return value.slice(3);
  return value;
}

function inferPeerKind(peerId, hasTopic) {
  if (hasTopic) return "group";
  if (peerId.startsWith("-")) return "group";
  return "dm";
}

export function buildConversationKey(ctx) {
  const channel = String(ctx?.channel || "unknown").toLowerCase();
  const accountId = String(ctx?.accountId || "default");
  const topicId = Number.isFinite(Number(ctx?.messageThreadId))
    ? Number(ctx?.messageThreadId)
    : null;
  const peerId = extractPeerId(ctx?.to || ctx?.from);
  const peerKind = inferPeerKind(peerId, topicId !== null);

  if (channel === "telegram" && topicId !== null) {
    return `telegram:${accountId}:${peerKind}:${peerId}:topic:${topicId}`;
  }

  return `${channel}:${accountId}:${peerKind}:${peerId}`;
}

export function parseConversationKey(conversationKey) {
  const parts = String(conversationKey || "").split(":");
  if (parts.length < 4) return null;

  const channel = parts[0] || "";
  const accountId = parts[1] || "";
  const peerKind = parts[2] || "";
  const peerId = parts[3] || "";

  let topicId = null;
  if (parts.length >= 6 && parts[4] === "topic") {
    const parsed = Number(parts[5]);
    if (Number.isFinite(parsed)) topicId = parsed;
  }

  return {
    channel,
    accountId,
    peerKind,
    peerId,
    topicId,
  };
}
