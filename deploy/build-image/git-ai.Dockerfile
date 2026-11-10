# syntax=docker/dockerfile:1.7
# Use an approved task-builder image and a locally supplied, checksum-pinned binary.
ARG TASK_BUILDER_IMAGE=mae-flow-task-builder:dev
FROM ${TASK_BUILDER_IMAGE}
USER root
ARG GIT_AI_SHA256
COPY git-ai /opt/git-ai/bin/git-ai
RUN test -n "${GIT_AI_SHA256}" \
    && echo "${GIT_AI_SHA256}  /opt/git-ai/bin/git-ai" | sha256sum -c - \
    && chmod 0755 /opt/git-ai/bin/git-ai \
    && command -v timeout
USER builder
RUN /opt/git-ai/bin/git-ai --version
