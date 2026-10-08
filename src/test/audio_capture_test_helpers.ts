import { blob_of } from './byte_route_test_helpers.ts';

/** A microphone track: `stop` closes it, and `ended` can be dispatched on it. */
export class FakeTrack extends EventTarget {
	stopped = false;
	stop(): void {
		this.stopped = true;
	}
}

/** A microphone stream with one track. */
export class FakeStream {
	readonly track = new FakeTrack();
	getTracks(): Array<FakeTrack> {
		return [this.track];
	}
}

/** A `MediaRecorder` that hands over chunks when told to. */
export class FakeMediaRecorder extends EventTarget {
	state: 'inactive' | 'recording' | 'paused' = 'inactive';
	timeslice: number | undefined;
	readonly stream: FakeStream;
	readonly options: MediaRecorderOptions;
	constructor(stream: FakeStream, options: MediaRecorderOptions) {
		super();
		this.stream = stream;
		this.options = options;
	}
	start(timeslice?: number): void {
		this.state = 'recording';
		this.timeslice = timeslice;
	}
	pause(): void {
		this.state = 'paused';
	}
	resume(): void {
		this.state = 'recording';
	}
	/** Hands over a chunk, as the browser does every timeslice. */
	emit(size: number): void {
		this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: blob_of(size) }));
	}
	/** The last chunk is dispatched before `stop`, like the real one. */
	final_chunk_size = 0;
	stop(): void {
		this.state = 'inactive';
		if (this.final_chunk_size) this.emit(this.final_chunk_size);
		this.dispatchEvent(new Event('stop'));
	}
}
