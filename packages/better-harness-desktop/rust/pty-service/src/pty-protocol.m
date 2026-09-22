// ABI metadata only: every listener, service and bridge behaviour is Rust.
#import <Foundation/Foundation.h>

@protocol HarnessPtyHostProtocol
- (void)sendFrame:(NSData *)frame;
@end

@protocol HarnessPtyClientProtocol
- (void)deliverFrame:(NSData *)frame;
- (void)hostFailed:(NSString *)reason;
@end

Protocol *harness_pty_host_protocol(void) { return @protocol(HarnessPtyHostProtocol); }
Protocol *harness_pty_client_protocol(void) { return @protocol(HarnessPtyClientProtocol); }
