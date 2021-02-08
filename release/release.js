const gitLogParser = require('git-log-parser');
const execa = require('execa');
const getStream = require('get-stream');
const parser = require('conventional-commits-parser').sync;
const filter = require('conventional-commits-filter');
const writer = require('conventional-changelog-writer');
const intoStream = require('into-stream')
const TerminalRenderer = require('marked-terminal');
const marked = require('marked');
const conventionalChangelogAngular = require('conventional-changelog-angular');
const {Octokit} = require('@octokit/rest');
const {format} = require('url');

marked.setOptions({renderer: new TerminalRenderer()});
cwd = process.cwd();
env = process.env;
const githubToken = env.GH_TOKEN || env.GITHUB_TOKEN;

Object.assign(gitLogParser.fields,
    {
        hash: 'H',
        message: 'B',
        gitTags: 'd',
        committerDate:
            {key: 'ci', type: Date}
    });

async function getCommits(from, to) {
    return (
        await getStream.array(
            gitLogParser.parse(
                {_: `${from ? from + '..' : ''}${to}`},
                {cwd: process.cwd(), env: {...process.env}}
            )
        )
    ).map(({message, gitTags, ...commit}) => ({
        ...commit,
        message: message.trim(),
        gitTags: gitTags.trim()
    }));
}

async function repoUrl(execaOptions) {
    try {
        return (await execa('git', ['config', '--get', 'remote.origin.url'], execaOptions)).stdout;
    } catch (error) {
        console.log(error);
    }
}

async function getTagHead(tagName, execaOptions) {
    return (await execa('git', ['rev-list', '-1', tagName], execaOptions)).stdout;
}


async function parseGithubUrl(repositoryUrl) {
    const [match, auth, host, path] = /^(?!.+:\/\/)(?:(?<auth>.*)@)?(?<host>.*?):(?<path>.*)$/.exec(repositoryUrl) || [];
    try {
        const [, owner, repo] = /^\/(?<owner>[^/]+)?\/?(?<repo>.+?)(?:\.git)?$/.exec(
            new URL(match ? `ssh://${auth ? `${auth}@` : ''}${host}/${path}` : repositoryUrl).pathname
        );
        return {owner, repo};
    } catch {
        return {};
    }
};

async function getFirstCommit(execaOptions) {
    return (await execa('git', ['rev-list', '--max-parents=0', 'HEAD'], execaOptions)).stdout;
}

async function getLatestTaggedCommit(execaOptions) {
    return env.CIRCLE_TAG || (await execa('git', ['rev-list', '--tags', '--max-count=1'], execaOptions)).stdout;
}

async function getVersionFromCommit({commit, execaOptions}) {
    //console.log("commit: " + commit);
    return (await execa('git', ['tag', '--points-at', commit], execaOptions)).stdout.split('\n').filter((value) => /^v/.test(value));
}

// async function getProdVersionFromCommit({commit, execaOptions}) {
//     return (await execa('git', ['tag', '--points-at', commit], execaOptions)).stdout.split('\n').filter((value) => /^v/.test(value));
// }

async function getLatestTag(execaOptions) {
    const latestSha = await getLatestTaggedCommit(execaOptions);
    // return (await execa('git', ['describe', '--tags', latestSha], execaOptions)).stdout;
    return await getVersionFromCommit({commit: latestSha, execaOptions});
}

function getClient() {
    return new Octokit({auth: `${githubToken}`});
}

async function prodRelease(notes, context) {
    const name = 'Production';

    const gitTag = await getLatestTag({cwd, env});
    const gitTagHead = await getTagHead(gitTag, {cwd, env});

    const {owner, repo} = context;

    const release = {
        owner,
        repo,
        tag_name: `${gitTag}`,
        target_commitish: gitTagHead,
        name,
        body: notes,
        prerelease: false,
    };
    return await context.client.repos.createRelease(release);
}


async function getRefProdCommit() {
    let prodVersion;
    try {
        prodVersion = await getTagHead('Production', {cwd, env});
    } catch (error) {
        prodVersion = await getFirstCommit({cwd, env});
    }
    return prodVersion;
}

async function releaseCleanup(context) {
    let gitTag = context.currentTag;

    const {owner, repo} = context;
    context.client = getClient();

    const {data: getRelease} = await context.client.repos.getReleaseByTag({
        owner,
        repo,
        tag: gitTag
    });
    const release_id = getRelease.id;

    await context.client.repos.deleteRelease({
        owner,
        repo,
        release_id
    })
}

async function getRepoDetails() {
    const repositoryUrl = await repoUrl({cwd, env});
    const {owner, repo} = await parseGithubUrl(repositoryUrl);
    return {repositoryUrl, owner, repo};
}

async function generateNotes({parsedCommits, gitTag, repo, urlHome, owner,
                                 previousTag, currentTag, linkCompare, writerOpts} = {}) {
    return await getStream(intoStream.object(parsedCommits).pipe(writer({
        version: gitTag,
        repository: repo,
        host: urlHome,
        owner,
        previousTag,
        currentTag,
        linkCompare
    }, {...writerOpts})));
}

function extractURL(repositoryUrl) {
    const [match, auth, host, path] = /^(?!.+:\/\/)(?:(?<auth>.*)@)?(?<host>.*?):(?<path>.*)$/.exec(repositoryUrl) || [];
    let {hostname, port, protocol} = new URL(
        match ? `ssh://${auth ? `${auth}@` : ''}${host}/${path}` : repositoryUrl
    );
    return {host, hostname, port, protocol};
}


async function generateChangeLogContext() {
    const loadedConfig = await conventionalChangelogAngular;
    const writerOpts = {...loadedConfig.writerOpts};
    const parserOpts = {...loadedConfig.parserOpts};
    return {writerOpts, parserOpts};
}

function getParsedCommits(commits, parserOpts) {
    return parsedCommits = filter(
        commits
            .filter(({message}) => {
                if (!message.trim()) {
                    return false;
                }
                return true;
            })
            .map(rawCommit => ({
                ...rawCommit,
                ...parser(rawCommit.message, {...parserOpts}),
            }))
    );
}

(async function ({cwd = process.cwd(), env = process.env, stdout, stderr} = {}) {
    const context = {
        cwd,
        env,
        stdout: stdout || process.stdout,
        stderr: stderr || process.stderr
    }
    try {
        context.gitTag = await getLatestTag({cwd, env});
        context.prodCommit = await getRefProdCommit();
        let [prodVersion,] = await getVersionFromCommit({
            commit: context.prodCommit,
            execOptions: {cwd, env}
        });
        // if prodVersion is null(first ever prod release), then set ref commit to first commit.
        prodVersion = prodVersion || context.prodCommit;
        const {writerOpts, parserOpts} = await generateChangeLogContext();

        // generate commits from last known prod version till circleTag.
        const commits = await getCommits(prodVersion, context.gitTag);
        context.commits = commits;

        const parsedCommits = getParsedCommits(commits, parserOpts);
        context.previousTag = prodVersion;
        context.currentTag = context.gitTag;
        //console.log(`${context.currentTag} .. ${context.previousTag}`);
        if (context.currentTag == context.previousTag){
            console.log(`Prod release is already pointing to the latest tag ${context.currentTag}`)
            return;
        }
        const linkCompare = context.currentTag && context.previousTag;

        // build args to generate notes
        const {repositoryUrl, owner, repo} = await getRepoDetails();
        let {hostname, port, protocol} = extractURL(repositoryUrl);
        const urlHome = format({protocol, host: hostname, port});
        const options = {
            gitTag: context.gitTag,
            previousTag: context.previousTag,
            currentTag: context.currentTag,
            linkCompare,
            writerOpts,
            repo,
            urlHome,
            owner,
            parsedCommits
        }
        const notes = await generateNotes(options);

        process.stdout.write(marked(notes));
        context.repositoryUrl = repositoryUrl;
        context.owner = owner;
        context.repo = repo;

        await releaseCleanup(context);

        await prodRelease(notes, context);
        console.log(`Production release is created with version tag ${context.gitTag}`);
    } catch (e) {
        const error = e.message;
        if (/already_exists/.test(error)) {
            console.log(e);
            console.log(`Already another release is created with ${context.gitTag}`);
            console.log(env.CIRCLE_TAG);
        }
        console.log(e);
    }
})();


