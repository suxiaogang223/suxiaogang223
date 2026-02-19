#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const START_MARKER = "<!--START_SECTION:recent_activity-->";
const END_MARKER = "<!--END_SECTION:recent_activity-->";

const DEFAULT_USERNAME = "suxiaogang223";
const DEFAULT_README_PATH = "README.md";
const MAX_ITEMS = 10;
const COMMIT_TARGET = 7;
const REPO_TARGET = 3;
const COMMIT_MESSAGE_MAX_LEN = 80;

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function safeText(text) {
  return oneLine(text).replace(/[\[\]`]/g, "");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown-date";
  }
  return date.toISOString().slice(0, 10);
}

async function githubGet(pathname, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "profile-readme-activity-updater",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com${pathname}`, {
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API request failed (${response.status} ${response.statusText}) for ${pathname}: ${body}`
    );
  }

  return response.json();
}

function extractCommits(events) {
  const seen = new Set();
  const items = [];

  for (const event of events) {
    if (event?.type !== "PushEvent") {
      continue;
    }

    const repoName = event?.repo?.name;
    const createdAt = event?.created_at;
    const timestamp = Date.parse(createdAt) || 0;
    const commits = event?.payload?.commits ?? [];

    for (const commit of commits) {
      const sha = commit?.sha;
      if (!repoName || !sha) {
        continue;
      }

      const key = `${repoName}:${sha}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const message = truncate(
        safeText(commit?.message || "No commit message"),
        COMMIT_MESSAGE_MAX_LEN
      );

      items.push({
        type: "commit",
        timestamp,
        date: formatDate(createdAt),
        repoName,
        sha,
        shortSha: sha.slice(0, 7),
        message,
        url: `https://github.com/${repoName}/commit/${sha}`,
      });
    }
  }

  items.sort((a, b) => b.timestamp - a.timestamp);
  return items;
}

function extractRepos(repos) {
  return repos
    .filter((repo) => repo && !repo.fork)
    .map((repo) => ({
      type: "repo",
      timestamp: Date.parse(repo.created_at) || 0,
      date: formatDate(repo.created_at),
      repoName: repo.full_name,
      repoDisplayName: repo.name,
      url: repo.html_url,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

function pickActivityItems(allCommits, allRepos) {
  const selectedCommits = allCommits.slice(0, COMMIT_TARGET);
  const selectedRepos = allRepos.slice(0, REPO_TARGET);
  const selected = [...selectedCommits, ...selectedRepos];

  if (selected.length < MAX_ITEMS) {
    const extraCommits = allCommits.slice(COMMIT_TARGET);
    const extraRepos = allRepos.slice(REPO_TARGET);
    const fallbackPool = [...extraCommits, ...extraRepos].sort(
      (a, b) => b.timestamp - a.timestamp
    );

    for (const item of fallbackPool) {
      if (selected.length >= MAX_ITEMS) {
        break;
      }
      selected.push(item);
    }
  }

  return selected.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_ITEMS);
}

function renderSection(items) {
  if (!items.length) {
    return "No recent public activity found.";
  }

  return items
    .map((item) => {
      if (item.type === "commit") {
        return `- ✅ Commit: [${item.repoName}@${item.shortSha}](${item.url}) - ${item.message} (${item.date})`;
      }
      return `- 🆕 Repo: [${item.repoDisplayName}](${item.url}) (${item.date})`;
    })
    .join("\n");
}

function replaceSection(content, section) {
  const startIndex = content.indexOf(START_MARKER);
  const endIndex = content.indexOf(END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(
      `Could not find valid section markers: ${START_MARKER} ... ${END_MARKER}`
    );
  }

  const before = content.slice(0, startIndex + START_MARKER.length);
  const after = content.slice(endIndex);
  return `${before}\n${section}\n${after}`;
}

async function main() {
  const username = process.env.GITHUB_USERNAME || DEFAULT_USERNAME;
  const token = process.env.GITHUB_TOKEN;
  const readmePath = process.env.README_PATH || DEFAULT_README_PATH;

  if (!token) {
    throw new Error("Missing GITHUB_TOKEN environment variable.");
  }

  const [events, repos] = await Promise.all([
    githubGet(`/users/${username}/events/public?per_page=100`, token),
    githubGet(
      `/users/${username}/repos?sort=created&direction=desc&per_page=100`,
      token
    ),
  ]);

  const commits = extractCommits(events);
  const createdRepos = extractRepos(repos);
  const selected = pickActivityItems(commits, createdRepos);
  const sectionText = renderSection(selected);

  const resolvedReadmePath = path.resolve(readmePath);
  const original = fs.readFileSync(resolvedReadmePath, "utf8");
  const updated = replaceSection(original, sectionText);

  if (updated === original) {
    console.log("README is already up to date.");
    return;
  }

  fs.writeFileSync(resolvedReadmePath, updated, "utf8");
  console.log(
    `Updated ${readmePath} with ${selected.length} activity item(s). commits=${commits.length}, repos=${createdRepos.length}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
