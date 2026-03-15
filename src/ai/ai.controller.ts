import { Controller, Get, Query, Sse } from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { map } from 'rxjs/operators';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

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

}
