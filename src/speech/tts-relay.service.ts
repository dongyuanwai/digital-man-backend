/**
 * TtsRelayService
 * - 将内部 AI 文本流事件转发至腾讯云流式 TTS WebSocket 服务
 * - 负责会话管理、缓冲待发送文本块、错误处理与资源回收
 * - 对外只暴露注册/注销客户端与事件处理，便于上层通过 WebSocket 输出音频流给浏览端
 *
 * 逻辑总览（事件→连接→合成→转发→关闭）：
 * 1) 上层通过 EventEmitter2 广播 AI_TTS_STREAM_EVENT（start/chunk/end/error）
 * 2) 本服务在 start 时建立腾讯云 ws；在 chunk 时发送 ACTION_SYNTHESIS；在 end 时发送 ACTION_COMPLETE
 * 3) 腾讯云返回二进制音频帧，直接透传给客户端 ws；同时传递状态（final/错误码）
 * 4) 会话发生错误或完成后，统一清理资源并通知客户端
 */
import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { OnEvent } from '@nestjs/event-emitter';
import {
  AI_TTS_STREAM_EVENT,
  type AiTtsStreamEvent,
} from '../common/stream-events';
import WebSocket from 'ws';

type ClientSession = {
  // 业务侧统一的会话标识
  sessionId: string;
  // 前端客户端 WebSocket（用于回传音频/状态）
  clientWs: WebSocket;
  // 与腾讯云 TTS 建立的 WebSocket 连接
  tencentWs?: WebSocket;
  // 腾讯云 ws 是否 ready，可发送合成文本
  ready: boolean;
  // 当未 ready 时暂存需要发送的文本块
  pendingChunks: string[];
  // 会话关闭标记，避免重复处理
  closed: boolean;
};

@Injectable()
export class TtsRelayService implements OnModuleDestroy {
  private readonly logger = new Logger(TtsRelayService.name);
  private readonly sessions = new Map<string, ClientSession>();
  private readonly secretId: string;
  private readonly secretKey: string;
  private readonly appId: number;
  private readonly voiceType: number;

  constructor(@Inject(ConfigService) configService: ConfigService) {
    // 从配置中读取腾讯云凭证与语音参数
    this.secretId = configService.get<string>('SECRET_ID') ?? '';
    this.secretKey = configService.get<string>('SECRET_KEY') ?? '';
    this.appId = Number(configService.get<string>('APP_ID') ?? 0);
    this.voiceType = Number(
      configService.get<string>('TTS_VOICE_TYPE') ?? 101001,
    );
  }

  onModuleDestroy(): void {
    // 模块销毁时，关闭所有会话，释放连接
    for (const session of this.sessions.values()) {
      this.closeSession(session.sessionId, 'module destroy');
    }
  }

  // 注册一个客户端连接，并返回 sessionId；如果存在同名会话则先关闭旧会话
  registerClient(clientWs: WebSocket, wantedSessionId?: string): string {
    const sessionId = wantedSessionId?.trim() || randomUUID();
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.closeSession(sessionId, 'client reconnected');
    }

    this.sessions.set(sessionId, {
      sessionId,
      clientWs,
      ready: false,
      pendingChunks: [],
      closed: false,
    });
    this.sendClientJson(clientWs, { type: 'session', sessionId });
    this.logger.log(`TTS client connected: ${sessionId}`);
    return sessionId;
  }

  // 注销客户端并清理资源
  unregisterClient(sessionId: string): void {
    this.closeSession(sessionId, 'client disconnected');
  }

  @OnEvent(AI_TTS_STREAM_EVENT)
  handleAiStreamEvent(event: AiTtsStreamEvent): void {
    const session = this.sessions.get(event.sessionId);
    if (!session) return;

    switch (event.type) {
      case 'start': {
        // 收到开始事件时，确保与腾讯云建立连接（如果已连接则复用）
        this.ensureTencentConnection(session);
        this.sendClientJson(session.clientWs, {
          type: 'tts_started',
          sessionId: session.sessionId,
          query: event.query,
        });
        break;
      }
      case 'chunk': {
        // 文本块事件：若腾讯云 ws 未就绪则先缓存；ready 后按 FIFO 发送，避免丢片
        const chunk = event.chunk?.trim();
        if (!chunk) return;
        if (
          !session.ready ||
          !session.tencentWs ||
          session.tencentWs.readyState !== WebSocket.OPEN
        ) {
          session.pendingChunks.push(chunk);
          return;
        }
        this.sendTencentChunk(session, chunk);
        break;
      }
      case 'end': {
        // 结束事件：冲刷缓冲并向腾讯云发送 complete 指令，提示对端合成结束
        this.flushPendingChunks(session);
        if (
          session.tencentWs &&
          session.tencentWs.readyState === WebSocket.OPEN
        ) {
          session.tencentWs.send(
            JSON.stringify({
              session_id: session.sessionId,
              action: 'ACTION_COMPLETE',
            }),
          );
        }
        break;
      }
      case 'error': {
        // 将错误反馈给前端并关闭会话，确保资源释放与状态一致
        this.sendClientJson(session.clientWs, {
          type: 'tts_error',
          message: event.error,
        });
        this.closeSession(session.sessionId, 'ai stream error');
        break;
      }
    }
  }

  // 确保与腾讯云 TTS 建立可用的 ws 连接
  private ensureTencentConnection(session: ClientSession): void {
    // readyState <= OPEN 表示“已打开或正在打开”，此时无需重连
    if (session.tencentWs && session.tencentWs.readyState <= WebSocket.OPEN) {
      return;
    }
    if (!this.secretId || !this.secretKey || !this.appId) {
      this.sendClientJson(session.clientWs, {
        type: 'tts_error',
        message: 'TTS 凭证缺失，请检查 SECRET_ID/SECRET_KEY/APP_ID',
      });
      return;
    }

    const url = this.buildTencentTtsWsUrl(session.sessionId);
    const tencentWs = new WebSocket(url);
    session.tencentWs = tencentWs;
    session.ready = false;

    tencentWs.on('open', () => {
      this.logger.log(`Tencent TTS ws opened: ${session.sessionId}`);
    });

    tencentWs.on('message', (data, isBinary) => {
      if (session.closed) return;
      if (isBinary) {
        // 二进制数据直接转发给客户端（即音频流片段），前端可直接解码播放
        if (session.clientWs.readyState === WebSocket.OPEN) {
          session.clientWs.send(data, { binary: true });
        }
        return;
      }

      const raw = data.toString();
      let msg: Record<string, unknown> | undefined;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      // ready=1 表示对端就绪；将缓冲区文本全部冲刷发送
      if (Number(msg.ready) === 1) {
        session.ready = true;
        this.flushPendingChunks(session);
      }

      // code!=0 表示腾讯云侧错误；同步反馈给客户端并关闭会话
      if (Number(msg.code) && Number(msg.code) !== 0) {
        this.sendClientJson(session.clientWs, {
          type: 'tts_error',
          message: String(msg.message ?? 'Tencent TTS error'),
          code: Number(msg.code),
        });
        this.closeSession(session.sessionId, 'tencent error');
        return;
      }

      // final=1 表示腾讯云已发送最终包：前端可据此结束播放流程
      if (Number(msg.final) === 1) {
        this.sendClientJson(session.clientWs, { type: 'tts_final' });
      }
    });

    tencentWs.on('error', (error) => {
      this.sendClientJson(session.clientWs, {
        type: 'tts_error',
        message: `Tencent ws error: ${error.message}`,
      });
    });

    tencentWs.on('close', () => {
      session.tencentWs = undefined;
      session.ready = false;
    });
  }

  // 将缓存中的文本块依次发送给腾讯云
  private flushPendingChunks(session: ClientSession): void {
    if (
      !session.ready ||
      !session.tencentWs ||
      session.tencentWs.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    // 采用队列顺序（FIFO）保证文本合成顺序一致
    while (session.pendingChunks.length > 0) {
      const chunk = session.pendingChunks.shift();
      if (!chunk) continue;
      this.sendTencentChunk(session, chunk);
    }
  }

  // 发送单个文本块给腾讯云 TTS
  private sendTencentChunk(session: ClientSession, text: string): void {
    if (!session.tencentWs || session.tencentWs.readyState !== WebSocket.OPEN) {
      session.pendingChunks.push(text);
      return;
    }

    session.tencentWs.send(
      JSON.stringify({
        session_id: session.sessionId,
        // 为每条文本生成唯一消息 ID，便于服务端追踪
        message_id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        action: 'ACTION_SYNTHESIS',
        data: text,
      }),
    );
  }

  // 关闭会话：断开两端 ws，并记录原因
  private closeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closed = true;

    if (session.tencentWs && session.tencentWs.readyState < WebSocket.CLOSING) {
      session.tencentWs.close();
    }
    if (session.clientWs.readyState < WebSocket.CLOSING) {
      this.sendClientJson(session.clientWs, { type: 'tts_closed', reason });
      session.clientWs.close();
    }
    this.sessions.delete(sessionId);
    this.logger.log(`TTS session closed: ${sessionId}, reason: ${reason}`);
  }

  // 安全发送 JSON 到客户端
  private sendClientJson(
    clientWs: WebSocket,
    payload: Record<string, unknown>,
  ): void {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    clientWs.send(JSON.stringify(payload));
  }

  // 构造腾讯云流式 TTS WebSocket 地址，并按文档规则签名
  private buildTencentTtsWsUrl(sessionId: string): string {
    const now = Math.floor(Date.now() / 1000);
    const params: Record<string, string | number> = {
      Action: 'TextToStreamAudioWSv2',
      AppId: this.appId,
      Codec: 'mp3',
      Expired: now + 3600,
      SampleRate: 16000,
      SecretId: this.secretId,
      SessionId: sessionId,
      Speed: 0,
      Timestamp: now,
      VoiceType: this.voiceType,
      Volume: 5,
    };

    // 生成签名：按 key 升序拼接 query，再用 HMAC-SHA1 对“GET + 主机 + 路径 + ?query”进行签名
    const signStr = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const rawStr = `GETtts.cloud.tencent.com/stream_wsv2?${signStr}`;
    const signature = createHmac('sha1', this.secretKey)
      .update(rawStr)
      .digest('base64');
    const searchParams = new URLSearchParams({
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
      Signature: signature,
    });

    return `wss://tts.cloud.tencent.com/stream_wsv2?${searchParams.toString()}`;
  }
}
