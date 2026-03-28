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

  @Sse('chat/stream/speech')
  chatStreamSpeech(
    @Query('query') query: string,
    @Query('ttsSessionId') ttsSessionId?: string,
  ): Observable<{ data: string }> {
    const sessionId = ttsSessionId?.trim();
    if (sessionId) {
      const startEvent: AiTtsStreamEvent = { type: 'start', sessionId, query };
      this.eventEmitter.emit(AI_TTS_STREAM_EVENT, startEvent);
    }

    return from(this.aiService.streamChainSpeech(query, sessionId)).pipe(
      map((chunk) => ({ data: chunk })),
    );
  }

}
