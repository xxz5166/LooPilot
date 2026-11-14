export namespace main {
	
	export class StartOptions {
	    mode: string;
	    safeMode: boolean;
	
	    static createFrom(source: any = {}) {
	        return new StartOptions(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mode = source["mode"];
	        this.safeMode = source["safeMode"];
	    }
	}

}

