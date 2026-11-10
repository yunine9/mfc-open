# syntax=docker/dockerfile:1.7

# Public defaults are pinned multi-platform manifests so a developer build is
# reproducible. Production must still override both with scanned internal
# mirrors pinned by their approved @sha256 digests.
ARG JAVA_MAVEN_BASE_IMAGE=maven:3.9.9-eclipse-temurin-21-jammy@sha256:7f8422bd81f19b9035007a75e2f82272b09af64db08848d7d4e93302466e8b6f
ARG NODE_BASE_IMAGE=node:18.16.1-bullseye-slim@sha256:1ba1ddfc61b385b6436fd0fa0d1d42d322a0cd03c1ff110fa39e828511152aef

FROM ${NODE_BASE_IMAGE} AS node_runtime

FROM ${JAVA_MAVEN_BASE_IMAGE}

ARG INSTALL_OS_PACKAGES=true
ARG BUILDER_UID=10001
ARG BUILDER_GID=10001

LABEL org.opencontainers.image.title="Mae-Flow Cloud task build environment" \
      org.opencontainers.image.description="JDK 21, Maven, Node 18/npm 9 and native build tools for isolated task commands" \
      com.mae-flow.builder.contract="mae-flow-task-builder/1" \
      com.mae-flow.toolchain.java="21" \
      com.mae-flow.toolchain.node="18.16.1" \
      com.mae-flow.toolchain.npm="9.5.1"

USER root

# A fully offline internal base image may already contain these packages; in
# that case build with INSTALL_OS_PACKAGES=false. The validation below still
# fails closed if the approved base is incomplete.
RUN if [ "${INSTALL_OS_PACKAGES}" = "true" ]; then \
      apt-get update; \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        binutils \
        bison \
        build-essential \
        ca-certificates \
        ccache \
        cmake \
        flex \
        g++ \
        gcc \
        git \
        ninja-build \
        pkg-config \
        procps \
        python3 \
        tini; \
      rm -rf /var/lib/apt/lists/*; \
    fi

# The official Node image owns the Node/npm distribution. Copying it avoids a
# curl/bootstrap script and keeps the compatibility baseline explicit.
COPY --from=node_runtime /usr/local/ /usr/local/

RUN groupadd --gid "${BUILDER_GID}" builder \
    && useradd --uid "${BUILDER_UID}" --gid "${BUILDER_GID}" \
      --create-home --home-dir /home/mae-flow --shell /bin/bash builder \
    && install -d -o "${BUILDER_UID}" -g "${BUILDER_GID}" \
      /cache/maven/repository \
      /cache/npm \
      /cache/ccache \
      /cache/xdg \
      /etc/mae-flow/ca \
      /etc/mae-flow/maven \
      /home/mae-flow/.m2

COPY entrypoint.sh /usr/local/bin/mae-flow-build-entrypoint
# 内部基础镜像常以 root 自测，容易把 0750 的 CLI/profile/CA 带进最终
# 非 root 镜像。这里先修通用只读/执行边界，再在 USER builder 之后用
# 与真实任务相同的 `sh -lc` 复验；不能让“镜像能 build”冒充“任务能跑”。
RUN set -eu; \
    chmod 0755 /usr/local/bin/mae-flow-build-entrypoint; \
    if [ -d /usr/local/bin ]; then \
      find /usr/local/bin -maxdepth 1 -type f -exec chmod a+rx {} +; \
    fi; \
    if [ -d /etc/profile.d ]; then \
      chmod a+rx /etc/profile.d; \
      find /etc/profile.d -maxdepth 1 -type f -exec chmod a+r {} +; \
    fi; \
    for directory in /home /etc/mae-flow /etc/mae-flow/maven /etc/mae-flow/ca; do \
      if [ -d "${directory}" ]; then chmod a+rx "${directory}"; fi; \
    done; \
    for directory in /etc/pki /etc/pki/tls /etc/pki/tls/certs /etc/ssl /etc/ssl/certs; do \
      if [ -d "${directory}" ]; then chmod a+rx "${directory}"; fi; \
    done; \
    for certificates in /etc/pki/tls/certs /etc/ssl/certs; do \
      if [ -d "${certificates}" ]; then \
        find "${certificates}" -maxdepth 1 -type f -exec chmod a+r {} +; \
      fi; \
    done; \
    for tool in java mvn node npm gcc g++ ld bison flex ccache git python3 codehub-cli spes; do \
      executable="$(command -v "${tool}" 2>/dev/null || true)"; \
      if [ -n "${executable}" ]; then \
        chmod a+rx "${executable}"; \
        resolved="$(readlink -f "${executable}" 2>/dev/null || printf '%s' "${executable}")"; \
        chmod a+rx "${resolved}"; \
        parent="$(dirname "${resolved}")"; \
        while [ "${parent}" != "/" ]; do chmod a+rx "${parent}"; parent="$(dirname "${parent}")"; done; \
      fi; \
    done

ENV HOME=/home/mae-flow \
    MAVEN_CONFIG=/home/mae-flow/.m2 \
    MFC_MAVEN_CACHE=/cache/maven/repository \
    MAVEN_OPTS="-Dmaven.repo.local=/cache/maven/repository" \
    NPM_CONFIG_CACHE=/cache/npm \
    NPM_CONFIG_USERCONFIG=/home/mae-flow/.npmrc \
    CCACHE_DIR=/cache/ccache \
    CCACHE_COMPRESS=true \
    CCACHE_MAXSIZE=5G \
    XDG_CACHE_HOME=/cache/xdg \
    TMPDIR=/tmp

WORKDIR /workspace
USER builder:builder

# 这段故意位于 USER 之后并使用 login shell：会真实触发 profile.d、PATH、
# CA 目录遍历和工具执行权限，覆盖 root 构建阶段看不见的 0750 问题。
RUN sh -lc 'set -eu; \
    passwd_home="$(awk -F: -v uid="$(id -u)" '\''$3 == uid { print $6; exit }'\'' /etc/passwd)"; \
    test -n "$passwd_home"; test "$passwd_home" = "$HOME"; \
    for script in /etc/profile.d/*.sh; do [ ! -e "$script" ] || [ -r "$script" ]; done; \
    for directory in /etc/pki /etc/pki/tls /etc/pki/tls/certs; do [ ! -e "$directory" ] || [ -x "$directory" ]; done; \
    for ca in /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt; do [ ! -e "$ca" ] || [ -r "$ca" ]; done; \
    for optional in codehub-cli spes; do path="$(command -v "$optional" 2>/dev/null || true)"; [ -z "$path" ] || [ -x "$path" ]; done; \
    java -version; \
    mvn_info="$(mvn --version 2>&1)"; printf "%s\\n" "$mvn_info"; \
    printf "%s\\n" "$mvn_info" | grep -Eq "Java version: 21([., ]|$)"; \
    mvn_java_home="$(printf "%s\\n" "$mvn_info" | sed -n "s/^.*runtime: \\([^,]*\\).*$/\\1/p" | head -n 1)"; \
    test -n "$mvn_java_home"; test -r "$mvn_java_home/lib/security/cacerts"; \
    test "$(node --version)" = "v18.16.1"; \
    test "$(npm --version)" = "9.5.1"; \
    gcc --version; g++ --version; ld --version; bison --version; flex --version; \
    ccache --version; git --version; python3 --version'

# Cloud starts task containers with Docker --init, so the image must not add a
# second nested init process. Standalone smoke runs should also pass --init.
ENTRYPOINT ["/usr/local/bin/mae-flow-build-entrypoint"]
CMD ["sleep", "infinity"]
