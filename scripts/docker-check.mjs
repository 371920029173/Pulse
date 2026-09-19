/**
 * Dockerfile sanity check.
 *
 * Docker is NOT available in the environment where this image was written, so the
 * image has not been built. Rather than leave a file nobody has checked at all, this
 * verifies the parts that can be verified without a daemon — which happens to cover
 * the mistakes that actually break a Dockerfile for this project:
 *
 *   1. Every `COPY <src>` names a path that exists in the repository. A typo here
 *      fails the build at that line, which is cheap to find once and expensive to
 *      find in CI.
 *   2. Every workspace package's manifest is referenced, so a new package cannot be
 *      silently missing from the dependency-install layer and blow up later.
 *   3. The UI dist is copied, because the server serves the UI from it and the app
 *      would otherwise come up with no interface.
 *   4. The runtime stage does not copy the whole build stage (which would ship
 *      sources, tests and the toolchain).
 *   5. `.env` is in `.dockerignore`, so API keys cannot enter a build context.
 *   6. The container runs as a non-root user, and binds a non-loopback address.
 *
 * What this does NOT check: that the layers actually build, that the base image tags
 * resolve, or that the service starts inside the container.
 *
 *   node scripts/docker-check.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
  }
};

const dockerfilePath = join(ROOT, 'Dockerfile');
const ignorePath = join(ROOT, '.dockerignore');

console.log('\nDockerfile 检查（无 docker，仅做静态核对）\n');

if (!existsSync(dockerfilePath)) {
  check('Dockerfile 存在', false, dockerfilePath);
  console.log(`\n1 项失败`);
  process.exit(1);
}

const dockerfile = readFileSync(dockerfilePath, 'utf8');
const lines = dockerfile.split(/\r?\n/);

// ─── 1. COPY sources exist ───
console.log('=== COPY 的源路径是否存在 ===');
{
  const missing = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.toUpperCase().startsWith('COPY')) continue;
    // COPY --from=build <src> <dest>   or   COPY <src> [<src>...] <dest>
    const parts = line.split(/\s+/).slice(1);
    const flags = parts.filter((p) => p.startsWith('--'));
    const args = parts.filter((p) => !p.startsWith('--'));
    const fromStage = flags.some((f) => f.startsWith('--from='));

    // Every arg except the last is a source.
    const sources = args.slice(0, -1);
    for (const src of sources) {
      // A source from a build stage refers to a path that stage produced, so it
      // cannot be checked against this working tree.
      if (fromStage) continue;
      const p = join(ROOT, src);
      if (!existsSync(p)) missing.push(src);
    }
  }
  check(
    `本地 COPY 源都存在（${missing.length} 处缺失）`,
    missing.length === 0,
    missing.join(', '),
  );
}

// ─── 2. Every workspace package is referenced ───
console.log('\n=== 是否覆盖了所有 workspace 包 ===');
{
  const packagesDir = join(ROOT, 'packages');
  const present = readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(packagesDir, e.name, 'package.json')))
    .map((e) => e.name);

  const notReferenced = present.filter(
    (name) => !dockerfile.includes(`packages/${name}/package.json`),
  );
  check(
    `所有包的 manifest 都被 COPY（${present.length} 个包）`,
    notReferenced.length === 0,
    notReferenced.length ? `未引用: ${notReferenced.join(', ')}` : undefined,
  );
}

// ─── 3. The UI build is shipped ───
console.log('\n=== 运行阶段是否带上必要产物 ===');
{
  check(
    '运行阶段复制了 UI 产物（没有它界面是空白）',
    /COPY --from=build .*packages\/ui\/dist/.test(dockerfile),
  );
  check(
    '运行阶段复制了 server 产物',
    /COPY --from=build .*packages\/server\/dist/.test(dockerfile),
  );
  check(
    '运行阶段复制了 node_modules',
    /COPY --from=build .*node_modules/.test(dockerfile),
  );
  check(
    'CMD 指向真实存在的入口',
    /CMD \["node", "packages\/server\/dist\/index\.js"\]/.test(dockerfile)
      && existsSync(join(ROOT, 'packages', 'server', 'dist', 'index.js')),
    '入口文件不存在（先 pnpm -r build）',
  );
}

// ─── 4. Runtime stage does not copy everything ───
console.log('\n=== 镜像是否干净 ===');
{
  check(
    '运行阶段没有整包复制 build 阶段',
    !/COPY --from=build \/app \/app\b/.test(dockerfile),
    '整包复制会把源码、测试和工具链一起打进镜像',
  );
  check(
    '构建阶段用 pnpm prune --prod 去掉开发依赖',
    /pnpm prune --prod/.test(dockerfile),
  );
  check(
    '依赖安装使用 frozen-lockfile（构建可复现）',
    /pnpm install --frozen-lockfile/.test(dockerfile),
  );
}

// ─── 5. Secrets cannot enter the context ───
console.log('\n=== 密钥防护 ===');
{
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : '';
  check('.dockerignore 存在', ignore.length > 0);
  check(
    '.dockerignore 排除 .env（否则密钥会进入构建上下文）',
    /^\.env\b/m.test(ignore) || /^\.env$/m.test(ignore),
    ignore.slice(0, 200),
  );
  check('.dockerignore 排除 .she/（本机状态）', /\.she\//.test(ignore));
}

// ─── 6. Container hardening and reachability ───
console.log('\n=== 容器行为 ===');
{
  check('以非 root 用户运行', /^USER node$/m.test(dockerfile));
  check(
    '绑定 0.0.0.0（否则容器内无法从外部访问）',
    /SHE_HOST=0\.0\.0\.0/.test(dockerfile),
  );
  check('声明了暴露端口', /EXPOSE 4577/.test(dockerfile));
  check('带健康检查', /HEALTHCHECK/.test(dockerfile));
  check(
    '有 init 进程回收孤儿（服务端会派生子进程）',
    /tini/.test(dockerfile),
  );
  check(
    '工作区与状态目录指向挂载点',
    /SHE_WORKSPACE=\/workspace/.test(dockerfile) && /SHE_STATE_DIR=\/workspace/.test(dockerfile),
  );
}

console.log('\n注意：本机没有 docker，以上只是静态核对。');
console.log('      真正的验证需要 `docker build -t she . && docker run ...`。');
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
