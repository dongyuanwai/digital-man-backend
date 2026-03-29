import { Controller, Get, Query, Sse } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { map } from 'rxjs/operators';
import { AiService } from './ai.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AI_TTS_STREAM_EVENT, type AiTtsStreamEvent } from '../common/stream-events';

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Get('chat') 
  async chat(@Query('query') query: string) {
    const response = await this.aiService.runChain(query);
    return { response };
  }
  
  @Sse('chat/stream')
  streamChat(@Query('query') query: string): Observable<{ data: string }> {
    let stream = this.aiService.runChainStream(query);
    return from(stream).pipe(
      map((data) => ({ data }))
    );
  }

  // 文本转语音（TTS）相关的流式接口：
  // - SSE 推送模型生成的文本片段给客户端，字段为 { data: string }
  // - 若提供 ttsSessionId，会通过应用内事件总线触发一条独立的 TTS 会话
  //   会话生命周期：控制器建立连接时发出 'start' 事件；生成阶段由 service 逐段发出 'chunk'；
  //   结束时由 service 发出 'end'；错误时发出 'error'。这样将文本流与音频合成解耦。
  @Sse('chat/stream/speech')
  chatStreamSpeech(
    @Query('query') query: string,            // 用户输入的查询/对话内容
    @Query('ttsSessionId') ttsSessionId?: string, // 可选的 TTS 会话 ID，用于在服务端关联音频合成管线
  ): Observable<{ data: string }> {
    // 去除首尾空白，确保会话 ID 的有效性
    const sessionId = ttsSessionId?.trim();
    if (sessionId) {
      // SSE 连接建立时，如果存在 TTS 会话 ID，立即广播一次“开始”事件
      // 下游的 TTS 处理器可据此初始化音频合成与推送通道
      const startEvent: AiTtsStreamEvent = { type: 'start', sessionId, query };
      this.eventEmitter.emit(AI_TTS_STREAM_EVENT, startEvent);
    }

    // 将模型输出的文本分片转成 SSE 数据帧：
    // - { data: chunk } 符合 NestJS SSE 的数据格式
    // - 同时 aiService.streamChainSpeech 会在后台为相同 sessionId 广播 'chunk'/'end'/'error' 事件，驱动 TTS
    return from(this.aiService.streamChainSpeech(query, sessionId)).pipe(
      map((chunk) => ({ data: chunk })),
    );
  }

}
