/** @jsxImportSource hono/jsx */
import type { FC, PropsWithChildren } from "hono/jsx";
import { TOPIC_LABELS, TOPIC_ORDER, type TopicId, VALID_TOPICS } from "../lib/topics";
import { GLOBAL_CSS } from "./styles";
import type { MemoryRow, SessionRow } from "./types";

export function topicLabel(topic: string | null): string {
	return TOPIC_LABELS[(topic || "general") as TopicId] || "General";
}

export function confidencePercent(confidence: number | null): string {
	const c = confidence ?? 0;
	return `${Math.round(c * 100)}%`;
}

export function sessionStatusLabel(row: SessionRow): string {
	const c = row.consolidated ?? 0;
	if (c === -1) return "Error";
	if (c === 0) return "Unconsolidated";
	return "Consolidated";
}

export const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => {
	return (
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>{title}</title>
				<link
					rel="icon"
					href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E🧠%3C/text%3E%3C/svg%3E"
				/>
				<meta property="og:title" content="divmemory - Persistent session memory" />
				<meta
					property="og:description"
					content="Persistent cross-session memory for coding agent"
				/>
				<meta property="og:type" content="website" />
				<style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />
			</head>
			<body>{children}</body>
		</html>
	);
};

export const LoginPage: FC<{ error: string; redirect: string }> = ({ error, redirect }) => {
	return (
		<Layout title="Login — divmemory">
			<div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f4f4f5">
				<div style="background:#fff;padding:32px;border-radius:12px;border:1px solid #e4e4e7;min-width:320px">
					<h2 style="margin:0 0 16px;font-size:18px">divmemory — Login</h2>
					{error && <div class="flash error">{error}</div>}
					<form method="post" action="/login">
						<input type="hidden" name="redirect" value={redirect} />
						<div style="margin-bottom:12px">
							<label
								htmlFor="web-password"
								style="display:block;font-size:13px;color:#52525b;margin-bottom:4px"
							>
								Password
							</label>
							<input
								id="web-password"
								type="password"
								name="password"
								style="width:100%;padding:8px;border:1px solid #d4d4d8;border-radius:6px"
								autofocus
							/>
						</div>
						<button type="submit" class="btn btn-primary" style="width:100%">
							Sign in
						</button>
					</form>
				</div>
			</div>
		</Layout>
	);
};

export const Sidebar: FC<{
	allProjects: { id: string; name: string | null; sessionCount: number | null }[];
	currentProject: { id: string; name: string | null } | undefined;
	showArchived: boolean;
}> = ({ allProjects, currentProject, showArchived }) => {
	return (
		<nav class="sidebar">
			{allProjects.length === 0 ? (
				<p class="no-projects">No projects yet.</p>
			) : (
				<>
					<h2>Projects</h2>
					<ul>
						{allProjects.map((p) => {
							const isCurrent = currentProject?.id === p.id;
							const href = `/?project=${encodeURIComponent(p.id)}${showArchived ? "&archived=1" : ""}`;
							return (
								<li key={p.id}>
									<a href={href} class={isCurrent ? "current" : undefined}>
										{p.name || p.id} <span class="count">{p.sessionCount ?? 0}</span>
									</a>
								</li>
							);
						})}
					</ul>
				</>
			)}
		</nav>
	);
};

export const MemoryCard: FC<{
	m: MemoryRow;
	pid: string;
	csrfValue: string;
	isEditing: boolean;
	isDeleteConfirming: boolean;
}> = ({ m, pid, csrfValue, isEditing, isDeleteConfirming }) => {
	const topic = m.topic || "general";
	const editHref = `/?project=${encodeURIComponent(pid)}&edit=${encodeURIComponent(m.id)}${m.status === "archived" ? "&archived=1" : ""}`;
	const deleteHref = `/?project=${encodeURIComponent(pid)}&delete=${encodeURIComponent(m.id)}${m.status === "archived" ? "&archived=1" : ""}`;

	if (isEditing) {
		return (
			<div class="memory-card editing">
				<form method="post" action="/" class="edit-form">
					<input type="hidden" name="_method" value="PATCH" />
					<input type="hidden" name="edit" value={m.id} />
					<input type="hidden" name="project" value={pid} />
					<input type="hidden" name="csrf_token" value={csrfValue} />
					<textarea name="content">{m.content || ""}</textarea>
					<div class="row">
						<select name="topic">
							{VALID_TOPICS.map((t) => (
								<option value={t} selected={topic === t ? true : undefined}>
									{TOPIC_LABELS[t]}
								</option>
							))}
						</select>
						<button type="submit" class="btn btn-primary">
							Save
						</button>
						<a href={`/?project=${encodeURIComponent(pid)}`} class="btn btn-secondary">
							Cancel
						</a>
					</div>
				</form>
				<form method="post" action="/" style="display:inline;margin-left:8px">
					<input type="hidden" name="_method" value="DELETE" />
					<input type="hidden" name="delete" value={m.id} />
					<input type="hidden" name="project" value={pid} />
					<input type="hidden" name="csrf_token" value={csrfValue} />
					<button type="submit" class="btn btn-danger" style="font-size:12px">
						Delete
					</button>
				</form>
			</div>
		);
	}

	if (isDeleteConfirming) {
		return (
			<div class="confirm-box">
				<p>Delete this memory?</p>
				<blockquote>{m.content || ""}</blockquote>
				<form method="post" action="/">
					<input type="hidden" name="_method" value="DELETE" />
					<input type="hidden" name="delete" value={m.id} />
					<input type="hidden" name="confirm" value="true" />
					<input type="hidden" name="project" value={pid} />
					<input type="hidden" name="csrf_token" value={csrfValue} />
					<button type="submit" class="btn btn-danger">
						Confirm Delete
					</button>
					<a href={`/?project=${encodeURIComponent(pid)}`} class="btn btn-secondary">
						Cancel
					</a>
				</form>
			</div>
		);
	}

	const actions =
		m.status === "archived" ? (
			<form method="post" action="/" style="display:inline">
				<input type="hidden" name="_method" value="PATCH" />
				<input type="hidden" name="id" value={m.id} />
				<input type="hidden" name="status" value="active" />
				<input type="hidden" name="project" value={pid} />
				<input type="hidden" name="csrf_token" value={csrfValue} />
				<button type="submit" class="btn btn-secondary" style="font-size:12px">
					Restore
				</button>
			</form>
		) : (
			<div class="memory-actions">
				<a href={editHref}>Edit</a>
				<a href={deleteHref}>Delete</a>
			</div>
		);

	return (
		<div class="memory-card">
			<div class="memory-content">{m.content || ""}</div>
			<div class="memory-meta">
				<span class="badge">{topicLabel(topic)}</span>
				<span class="badge">{confidencePercent(m.confidence)}</span>
				{m.curated ? <span class="badge curated">Curated</span> : undefined}
			</div>
			{actions}
		</div>
	);
};

export const TopicGroup: FC<{
	topic: string;
	memories: MemoryRow[];
	pid: string;
	csrfValue: string;
	editId: string | undefined;
	deleteId: string | undefined;
	isArchivedView: boolean;
}> = ({ topic, memories, pid, csrfValue, editId, deleteId, isArchivedView }) => {
	if (!memories.length) return null;
	return (
		<div class="topic-group">
			<h3>{TOPIC_LABELS[topic as TopicId] || topic}</h3>
			{memories.map((m) => {
				const isEditing = m.id === editId && !isArchivedView;
				const isDeleting = m.id === deleteId && !isArchivedView;
				return (
					<MemoryCard
						key={m.id}
						m={m}
						pid={pid}
						csrfValue={csrfValue}
						isEditing={isEditing}
						isDeleteConfirming={isDeleting}
					/>
				);
			})}
		</div>
	);
};

export const SessionLogComponent: FC<{ rows: SessionRow[] }> = ({ rows }) => {
	if (!rows.length) {
		return (
			<div class="session-log">
				<h3>Session Log</h3>
				<p class="empty">No sessions yet.</p>
			</div>
		);
	}
	return (
		<div class="session-log">
			<h3>Session Log</h3>
			{rows.map((r) => {
				const label = sessionStatusLabel(r);
				const statusClass =
					r.consolidated === -1
						? "error"
						: r.consolidated === 0
							? "unconsolidated"
							: "consolidated";
				return (
					<div class="session-row">
						<span class="id">{r.id}</span>
						<span class="date">{r.createdAt ?? ""}</span>
						<span class={`status ${statusClass}`}>{label}</span>
						<span class="tokens">{r.tokenCount ?? 0} tokens</span>
						{r.extractionError ? <span class="err">{r.extractionError}</span> : undefined}
					</div>
				);
			})}
		</div>
	);
};

export const Flash: FC<{ success: string; error: string }> = ({ success, error }) => {
	if (success) return <div class="flash success">{success}</div>;
	if (error) return <div class="flash error">{error}</div>;
	return null;
};

export const ProjectStatus: FC<{
	activeMemories: number;
	curatedMemories: number;
	pendingSessions: number;
	errorSessions: number;
}> = ({ activeMemories, curatedMemories, pendingSessions, errorSessions }) => {
	return (
		<section class="status-card" aria-label="Project Status">
			<h3>Project Status</h3>
			<div class="status-grid">
				<div class="status-item">
					<span class="label">Active memories</span>
					<span class="value">{activeMemories}</span>
				</div>
				<div class="status-item">
					<span class="label">Curated</span>
					<span class="value">{curatedMemories}</span>
				</div>
				<div class="status-item">
					<span class="label">Pending consolidation</span>
					<span class="value">{pendingSessions}</span>
				</div>
				<div class="status-item">
					<span class="label">Extraction error sessions</span>
					<span class="value">{errorSessions}</span>
				</div>
			</div>
		</section>
	);
};

export const MainPage: FC<{
	allProjects: { id: string; name: string | null; sessionCount: number | null }[];
	currentProject: { id: string; name: string | null; sessionCount?: number | null } | undefined;
	memRows: MemoryRow[];
	sessionRows: SessionRow[];
	unconsolidatedCount: number;
	statusStats: {
		activeMemories: number;
		curatedMemories: number;
		pendingSessions: number;
		errorSessions: number;
	};
	searchQuery: string;
	editId: string | undefined;
	deleteId: string | undefined;
	showArchived: boolean;
	csrfValue: string;
	success: string;
	error: string;
}> = ({
	allProjects,
	currentProject,
	memRows,
	sessionRows,
	unconsolidatedCount,
	statusStats,
	searchQuery,
	editId,
	deleteId,
	showArchived,
	csrfValue,
	success,
	error,
}) => {
	const title = currentProject
		? `${currentProject.name || currentProject.id} — divmemory`
		: "divmemory";

	let main: ReturnType<FC>;
	if (!currentProject) {
		main = (
			<div class="main">
				<div class="memories">
					<h1>divmemory</h1>
					<p class="empty">Select a project from the sidebar, or create one via the API.</p>
				</div>
			</div>
		);
	} else {
		const pid = currentProject.id;
		const isNonexistent = !allProjects.some((p) => p.id === pid);
		if (isNonexistent) {
			main = (
				<div class="main">
					<div class="memories">
						<h1>{currentProject.name || pid}</h1>
						<div class="flash error">Project not found</div>
					</div>
				</div>
			);
		} else {
			const grouped: Record<string, MemoryRow[]> = {};
			for (const t of TOPIC_ORDER) grouped[t] = [];
			for (const m of memRows) {
				const t = m.topic || "general";
				if (!grouped[t]) grouped[t] = [];
				grouped[t].push(m);
			}

			const topicFrags = TOPIC_ORDER.map((t) => (
				<TopicGroup
					topic={t}
					memories={grouped[t]}
					pid={pid}
					csrfValue={csrfValue}
					editId={editId}
					deleteId={deleteId}
					isArchivedView={showArchived}
				/>
			));
			const extraTopics = Object.keys(grouped).filter((k) => !TOPIC_ORDER.includes(k as TopicId));
			for (const t of extraTopics) {
				topicFrags.push(
					<TopicGroup
						topic={t}
						memories={grouped[t]}
						pid={pid}
						csrfValue={csrfValue}
						editId={editId}
						deleteId={deleteId}
						isArchivedView={showArchived}
					/>,
				);
			}

			const archivedToggle = showArchived ? (
				<div class="archived-toggle">
					<a href={`/?project=${encodeURIComponent(pid)}`}>Hide Archived</a>
				</div>
			) : (
				<div class="archived-toggle">
					<a href={`/?project=${encodeURIComponent(pid)}&archived=1`}>Show Archived</a>
				</div>
			);

			const consolidateFrag =
				unconsolidatedCount >= 2 && !showArchived ? (
					<form method="post" action="/" class="consolidate-form">
						<input type="hidden" name="action" value="consolidate" />
						<input type="hidden" name="project" value={pid} />
						<input type="hidden" name="csrf_token" value={csrfValue} />
						<button type="submit" class="btn btn-primary">
							Consolidate ({unconsolidatedCount} pending)
						</button>
					</form>
				) : null;

			const memoriesFrag =
				memRows.length > 0 ? (
					topicFrags
				) : (
					<p class="empty">No {showArchived ? "archived" : "active"} memories for this project.</p>
				);

			main = (
				<div class="main">
					<div class="memories">
						<div class="header-bar">
							<h1>{currentProject.name || pid}</h1>
							<form method="post" action="/logout" class="logout-form">
								<input type="hidden" name="csrf_token" value={csrfValue} />
								<button type="submit" class="btn btn-secondary">
									Logout
								</button>
							</form>
						</div>
						<Flash success={success} error={error} />
						<ProjectStatus {...statusStats} />
						<form method="get" action="/" class="search-form">
							<input type="hidden" name="project" value={pid} />
							{showArchived ? <input type="hidden" name="archived" value="1" /> : undefined}
							<input
								type="search"
								name="search"
								value={searchQuery}
								placeholder="Search memories"
							/>
							<button type="submit" class="btn btn-secondary">
								Search
							</button>
							{searchQuery ? (
								<a
									href={`/?project=${encodeURIComponent(pid)}${showArchived ? "&archived=1" : ""}`}
									class="btn btn-secondary"
								>
									Clear
								</a>
							) : undefined}
						</form>
						{archivedToggle}
						{consolidateFrag}
						{memoriesFrag}
						<SessionLogComponent rows={sessionRows} />
					</div>
				</div>
			);
		}
	}

	return (
		<Layout title={title}>
			<div class="container">
				<Sidebar
					allProjects={allProjects}
					currentProject={currentProject}
					showArchived={showArchived}
				/>
				{main}
			</div>
		</Layout>
	);
};
