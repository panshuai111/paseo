import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = homedir();
const workspace = join(root, "Projects/Hermes Feishu");
const directory =
  process.env.PASEO_HERMES_STATE_DIR ?? join(root, ".local/state/paseo-hermes-feishu");
const catalogFile = join(directory, "catalog.json");
const titlesFile = join(directory, "workspace-titles.json");
const activityFile = join(directory, "inbound-activity.json");
const autoRestoreSince = Date.parse(process.env.PASEO_HERMES_AUTO_RESTORE_SINCE ?? "");
const providerId = "hermes-feishu";
const label = "hermes-feishu.session";
const migrationLabel = "hermes-feishu.migrate-from";
const migrationSource = process.argv[2];
const { DaemonClient } = await import(pathToFileURL(process.env.PASEO_CLIENT_MODULE).href);
const client = new DaemonClient({
  url: process.env.PASEO_SYNC_URL,
  password: process.env.PASEO_PASSWORD,
  clientId: "hermes-feishu-sync",
  clientType: "cli",
});

await mkdir(workspace, { recursive: true });

let managedTitles;
async function loadManagedTitles() {
  if (managedTitles) return;
  try {
    const data = JSON.parse(await readFile(titlesFile, "utf8"));
    managedTitles = new Map(Object.entries(data));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    managedTitles = new Map();
  }
}

async function rememberTitle(sessionId, title) {
  if (managedTitles.get(sessionId) === title) return;
  const updated = new Map(managedTitles).set(sessionId, title);
  const temp = titlesFile + "." + process.pid + ".tmp";
  await writeFile(temp, JSON.stringify(Object.fromEntries(updated)), { mode: 0o600 });
  await rename(temp, titlesFile);
  managedTitles = updated;
}

async function existingSessions() {
  const sessions = new Map();
  let cursor;
  do {
    const page = await client.fetchAgents({
      filter: { includeArchived: true },
      page: { limit: 100, cursor },
    });
    for (const { agent } of page.entries) {
      const key = agent.labels[label];
      if (agent.provider === providerId && key && (!agent.archivedAt || !sessions.has(key))) {
        sessions.set(key, agent);
      }
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return sessions;
}

async function findProject() {
  const { projects } = await client.listProjects();
  const existing = projects.find((candidate) => candidate.projectRootPath === workspace);
  if (existing) return existing;
  const added = await client.addProject(workspace);
  if (!added.project) throw new Error(added.error ?? "Cannot register the Hermes project");
  return added.project;
}

async function listConversationWorkspaces(projectId) {
  const workspaces = new Map();
  let cursor;
  do {
    const page = await client.fetchWorkspaces({
      filter: { projectId },
      page: { limit: 100, cursor },
    });
    for (const entry of page.entries) {
      const sessionId = entry.metadata?.[label];
      if (sessionId) workspaces.set(sessionId, entry);
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return workspaces;
}

async function createConversationWorkspace(projectId, id, title) {
  const metadata = { [label]: id };
  if (migrationSource) metadata[migrationLabel] = migrationSource;
  const created = await client.createWorkspace({
    source: { kind: "directory", path: workspace, projectId },
    idempotencyKey: "hermes-feishu:" + id,
    title,
    metadata,
  });
  if (!created.workspace) throw new Error(created.error ?? "Cannot create a Hermes workspace");
  return created.workspace;
}

function importConversation(id, workspaceId) {
  return client.importAgent({
    providerId,
    providerHandleId: "plugin:" + JSON.stringify({ version: 1, data: id }),
    cwd: workspace,
    workspaceId,
    labels: { [label]: id },
  });
}

async function moveConversation(id, agent, destination) {
  if (!agent.archivedAt) await client.archiveAgent(agent.id);
  try {
    const moved = await importConversation(id, destination.id);
    if (moved.id !== agent.id || moved.workspaceId !== destination.id) {
      throw new Error("Hermes migration returned unexpected Paseo identity");
    }
  } catch (error) {
    const current = (await existingSessions()).get(id);
    if (current?.id === agent.id && !current.archivedAt && current.workspaceId === destination.id) {
      return;
    }
    if (current?.id === agent.id && current.archivedAt && current.workspaceId === migrationSource) {
      await importConversation(id, migrationSource);
    }
    throw error;
  }
}

function parseCatalog(catalog) {
  const ids = JSON.parse(catalog);
  if (
    !Array.isArray(ids) ||
    !ids.every((id) => typeof id === "string" && /^[\w-]{1,128}$/.test(id))
  ) {
    throw new Error("Malformed Hermes catalog");
  }
  return [...new Set(ids)];
}

async function placeConversation(id, agent, pending, projectId) {
  if (agent?.archivedAt && pending?.metadata?.[migrationLabel] !== migrationSource) return;
  const snapshot = JSON.parse(await readFile(join(directory, id + ".json"), "utf8"));
  if (migrationSource && (snapshot.running || agent.status === "running")) {
    throw new Error("A Hermes conversation is still running; retry after it becomes idle");
  }
  const title =
    snapshot.workspaceTitle?.trim() ||
    snapshot.title?.trim() ||
    agent?.title ||
    "飞书会话 " + id.slice(-8);
  const destination = pending ?? (await createConversationWorkspace(projectId, id, title));
  if (migrationSource) await moveConversation(id, agent, destination);
  else {
    await importConversation(id, destination.id);
    await rememberTitle(id, destination.title ?? title);
  }
  console.info(
    migrationSource
      ? "Moved one Hermes Feishu conversation"
      : "Synchronized one Hermes Feishu conversation",
  );
}

async function updateExistingTitle(id, agent, entry) {
  if (!entry || agent.archivedAt || agent.workspaceId !== entry.id) return;
  const snapshot = JSON.parse(await readFile(join(directory, id + ".json"), "utf8"));
  const title = snapshot.workspaceTitle?.trim();
  if (!title) return;

  const current = entry.title ?? entry.displayName;
  const previous = managedTitles.get(id);
  if (current !== title && previous !== undefined && current !== previous) return;
  if (current !== title) await client.setWorkspaceTitle(entry.id, title);
  await rememberTitle(id, title);
}

function arrivedAfterArchive(message, archivedAt) {
  return (
    typeof message?.id === "string" &&
    /^om_[a-zA-Z0-9_-]+$/.test(message.id) &&
    Date.parse(message.at) > Math.max(Date.parse(archivedAt), autoRestoreSince)
  );
}

function sameConversation(agent, id, workspaceId) {
  return (
    agent?.provider === providerId &&
    agent.labels[label] === id &&
    agent.workspaceId === workspaceId
  );
}

async function restoreOnNewMessage(id, agent, message, activeWorkspace) {
  if (
    !agent.workspaceId ||
    agent.cwd !== workspace ||
    !arrivedAfterArchive(message, agent.archivedAt)
  ) {
    return;
  }

  let current = (await client.fetchAgent(agent.id))?.agent;
  if (
    !sameConversation(current, id, agent.workspaceId) ||
    !arrivedAfterArchive(message, current.archivedAt)
  ) {
    return;
  }

  if (!activeWorkspace || activeWorkspace.id !== current.workspaceId) {
    const recovery = await client.inspectWorkspaceRecovery(current.workspaceId);
    if (
      recovery.kind !== "recoverable" ||
      recovery.workspaceId !== current.workspaceId ||
      recovery.branch
    ) {
      return;
    }
    await client.restoreWorkspace(current.workspaceId);
    current = (await client.fetchAgent(agent.id))?.agent;
  }
  if (!sameConversation(current, id, agent.workspaceId)) return;
  if (current.archivedAt) {
    if (!arrivedAfterArchive(message, current.archivedAt)) return;
    await client.refreshAgent(agent.id);
  }
  console.info("Restored one Hermes Feishu conversation after a new message");
}

async function readActivity() {
  if (migrationSource) return "{}";
  try {
    return await readFile(activityFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "{}";
    throw error;
  }
}

const verifiedTimelineHeads = new Map();
const pendingTimelines = new Map();

async function verifyTimeline(id, agent, head) {
  if (typeof head !== "string" || verifiedTimelineHeads.get(id) === head) {
    pendingTimelines.delete(id);
    return;
  }

  const pending = pendingTimelines.get(id);
  if (pending?.head !== head) {
    // Allow the existing provider watcher to publish its snapshot before recovering it.
    pendingTimelines.set(id, { head, checkAfter: Date.now() + 3_000 });
    return;
  }
  if (pending.checkAfter > Date.now()) return;
  pending.checkAfter = Date.now() + 5_000;

  const includesHead = async () => {
    const page = await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 120 });
    return page.entries.some(({ item }) => item.messageId === head);
  };
  if (!(await includesHead())) {
    const current = (await client.fetchAgent(agent.id))?.agent;
    if (!sameConversation(current, id, agent.workspaceId) || current.archivedAt) {
      pendingTimelines.delete(id);
      return;
    }
    if (current.status === "running" || current.status === "initializing") return;
    await client.refreshAgent(agent.id);
    if (!(await includesHead())) return;
    console.info("Refreshed one stale Hermes Feishu timeline");
  }
  verifiedTimelineHeads.set(id, head);
  pendingTimelines.delete(id);
}

async function reconcileConversations(ids, existing, workspaces, inbound) {
  for (const id of ids) {
    const agent = existing.get(id);
    const entry = workspaces.get(id);
    if (!agent || agent.archivedAt) {
      pendingTimelines.delete(id);
      if (agent) await restoreOnNewMessage(id, agent, inbound[id], entry);
      continue;
    }

    await updateExistingTitle(id, agent, entry);
    if (entry?.id === agent.workspaceId) {
      await verifyTimeline(id, agent, inbound[id]?.timelineHead);
    } else {
      pendingTimelines.delete(id);
    }
  }
}

const reportedWorkspaceConflicts = new Set();

async function enrollConversations(candidates, existing, workspaces, projectId) {
  for (const id of candidates) {
    try {
      await placeConversation(id, existing.get(id), workspaces.get(id), projectId);
      reportedWorkspaceConflicts.delete(id);
    } catch (error) {
      // The durable creation receipt can outlive a removed project. Preserve it
      // and continue enrolling the remaining conversations.
      if (migrationSource || error?.message !== "workspace_request_key_conflict") throw error;
      if (reportedWorkspaceConflicts.has(id)) continue;
      reportedWorkspaceConflicts.add(id);
      console.info(
        "Kept a previously enrolled Hermes workspace with a conflicting creation receipt",
      );
    }
  }
}

let lastCatalog;
let lastActivity;
let lastReconciled = 0;
async function sync() {
  const catalog = await readFile(catalogFile, "utf8");
  const activity = await readActivity();
  const now = Date.now();
  const timelineDue = [...pendingTimelines.values()].some(({ checkAfter }) => checkAfter <= now);
  if (
    catalog === lastCatalog &&
    activity === lastActivity &&
    !timelineDue &&
    now - lastReconciled < 60_000
  ) {
    return;
  }
  const inbound = JSON.parse(activity);
  const ids = parseCatalog(catalog);
  const catalogIds = new Set(ids);
  for (const id of pendingTimelines.keys()) {
    if (!catalogIds.has(id)) pendingTimelines.delete(id);
  }
  for (const id of verifiedTimelineHeads.keys()) {
    if (!catalogIds.has(id)) verifiedTimelineHeads.delete(id);
  }
  const existing = await existingSessions();
  const candidates = migrationSource
    ? ids.filter((id) => existing.get(id)?.workspaceId === migrationSource)
    : ids.filter((id) => !existing.has(id));
  if (ids.length) {
    if (!migrationSource) await loadManagedTitles();
    const project = await findProject();
    const workspaces = await listConversationWorkspaces(project.projectId);
    await enrollConversations(candidates, existing, workspaces, project.projectId);
    if (!migrationSource) {
      await reconcileConversations(ids, existing, workspaces, inbound);
    }
  }
  lastCatalog = catalog;
  lastActivity = activity;
  lastReconciled = Date.now();
}

await client.connect();
if (migrationSource) {
  try {
    await sync();
  } finally {
    client.close();
  }
  process.exit(0);
}
for (;;) {
  try {
    await sync();
  } catch (error) {
    console.warn("Hermes enrollment:", error instanceof Error ? error.message : "Unknown error");
  }
  await sleep(5_000);
}
