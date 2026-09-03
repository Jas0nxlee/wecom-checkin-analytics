# 企业微信打卡分析看板 —— 后端仅依赖 Python 标准库，无需第三方依赖。
FROM python:3.12-slim

# 非 root 运行更安全，但此处需要 data/ 可写（抓取会写 data/*.json、*.csv、.fetch.lock）。
# 数据与凭证用卷挂载，镜像内不放任何敏感内容。保留 root 以便容器进程写挂载卷。
WORKDIR /app

# 先复制依赖最小集以利用层缓存；本项目无 pip 依赖，仅固定时区。
ENV TZ=Asia/Shanghai
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 复制后端与前端源码（.dockerignore 已排除 data/、config.json 等敏感与冗余内容）
COPY server.py fetch_checkin.py checkin_policy.py ./
COPY web ./web
COPY tools ./tools

# 数据默认目录（会被 compose 挂载覆盖）
RUN mkdir -p /app/data

EXPOSE 8787

# 绑定 0.0.0.0 才能被容器外/内网访问；port 沿用项目默认 8787
CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8787"]
