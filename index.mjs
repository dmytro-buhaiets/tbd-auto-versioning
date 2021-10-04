//TODO Add "revert" commits support

import core from '@actions/core';
import github from '@actions/github';
import {createActionAuth} from '@octokit/auth-action';
import {Octokit} from '@octokit/rest';

const RELEASE_BRANCH_REGEXP = /^release\/(?<version>\d+\.\d+)\.x$/;
const VERSION_TAG_REGEXP = /^v(\d+)\.(\d+).(\d+)$/;
const SHORT_BREAKING_CHANGE_REGEXP = /^\w+(?:\(\w+\))?!/;
const LONG_BERAKING_CHANGE_REGEXP = /^breaking[ -]change/i;

function parseVersionTag(versionTag) {
    return VERSION_TAG_REGEXP.exec(versionTag).slice(1);
}

const octokit = new Octokit({authStrategy: createActionAuth});

async function getBranchCommitsAfterTag(branch, tag) {
    let commitsAfterTag = [];
    let page = 1;
    while (true) {
        const {data: commits} = await octokit.repos.listCommits({
            ...github.context.repo,
            sha: branch.name,
            per_page: 100,
            page
        });

        let latestTagCommitIndex = -1;

        for (let i = 0; i < commits.length; i++)
            if (commits[i].sha === tag.commit.sha) {
                latestTagCommitIndex = i;
                break;
            }

        if (latestTagCommitIndex === -1) {
            commitsAfterTag = commitsAfterTag.concat(commits);
            page++;
        } else
            return commitsAfterTag.concat(commits.slice(0, latestTagCommitIndex)).reverse();
    }
}

async function createTag(tag, commit) {
    const {data: tagObject} = await octokit.git.createTag({
        ...github.context.repo,
        tag,
        message: tag,
        object: commit.sha,
        type: 'commit'
    });

    await octokit.git.createRef({
        ...github.context.repo,
        ref: `refs/tags/${tag}`,
        sha: tagObject.sha
    });

    core.notice(`New tag "${tag}" created`);
}

async function updateOrCreateTag(tag, commit) {
    const {data: tagObject} = await octokit.git.createTag({
        ...github.context.repo,
        tag,
        message: tag,
        object: commit.sha,
        type: 'commit'
    });

    try {
        await octokit.git.updateRef({
            ...github.context.repo,
            ref: `tags/${tag}`,
            sha: tagObject.sha,
            force: true
        });

        core.notice(`Tag "${tag}" updated`);
    } catch (error) {
        await octokit.git.createRef({
            ...github.context.repo,
            ref: `refs/tags/${tag}`,
            sha: tagObject.sha
        });

        core.notice(`Tag "${tag}" created`);
    }
}

async function createBranch(branch, commit) {
    await octokit.git.createRef({
        ...github.context.repo,
        ref: `refs/heads/${branch}`,
        sha: commit.sha
    });

    core.notice(`New branch "${branch}" created`);
}

const {data: branches} = await octokit.repos.listBranches(github.context.repo);

const releaseBranches = branches.filter(({name}) => RELEASE_BRANCH_REGEXP.test(name));
if (releaseBranches.length === 0) {
    core.error('Cannot find release branches (e. g. release/1.0.x). Create at least one release branch manually');
    process.exit(1);
}

const {data: tags} = await octokit.repos.listTags(github.context.repo);

const versionTags = tags.filter(({name}) => VERSION_TAG_REGEXP.test(name));

if (versionTags.length === 0) {
    core.error('Cannot find version tags (e. g. v.1.0.0). Create at least one tag manually');
    process.exit(1);
}

const shortTagToCommit = new Map();

//TODO https://nodejs.org/api/worker_threads.html
for (const releaseBranch of releaseBranches) {
    const {version: releaseVersion} = RELEASE_BRANCH_REGEXP.exec(releaseBranch.name).groups;
    const branchLatestTag = versionTags.filter(({name}) => name.startsWith(`v${releaseVersion}`))[0];

    let [major, minor, patch] = parseVersionTag(branchLatestTag.name);

    const releaseCommitsAfterTag = await getBranchCommitsAfterTag(releaseBranch, branchLatestTag);
    for (const commit of releaseCommitsAfterTag)
        if (commit.commit.message.toLowerCase().startsWith('fix')) {
            const tag = `v${major}.${minor}.${++patch}`;
            createTag(tag, commit);

            if (tag > versionTags.filter(tag => tag.name.startsWith(`v${major}`))[0].name)
                shortTagToCommit.set(`v${major}`, commit);

            shortTagToCommit.set(`v${major}.${minor}`, commit);

            if (tag > versionTags[0].name)
                shortTagToCommit.set('latest', commit);
        }
}

const trunkBranchName = core.getInput('trunkBranch');

const {data: trunkBranch} = await octokit.repos.getBranch({
    ...github.context.repo,
    branch: trunkBranchName
});

const minorVersionTags = versionTags.filter(({name}) => /^v\d+\.\d+\.0$/.test(name));

let [major, minor] = parseVersionTag(minorVersionTags[0].name);

const trunkCommitsAfterTag = await getBranchCommitsAfterTag(trunkBranch, minorVersionTags[0]);

for (const commit of trunkCommitsAfterTag) {
    if (commit.commit.message.toLowerCase().startsWith('feat')) {
        createTag(`v${major}.${++minor}.0`, commit);

        createBranch(`release/${major}.${minor}.x`, commit);

        shortTagToCommit.set(`v${major}`, commit);
        shortTagToCommit.set(`v${major}.${minor}`, commit);
        shortTagToCommit.set('latest', commit);
    } else if (SHORT_BREAKING_CHANGE_REGEXP.test(commit.commit.message)
        || LONG_BERAKING_CHANGE_REGEXP.test(commit.commit.message.split('\n').at(-1))) {
        minor = 0;
        [
            `v${++major}`,
            `v${major}.0`,
            `v${major}.0.0`
        ].forEach(tag => createTag(tag, commit));

        createBranch(`release/${major}.0.x`, commit);

        shortTagToCommit.set('latest', commit);
    }
}

shortTagToCommit.forEach((commit, tag) => updateOrCreateTag(tag, commit));
