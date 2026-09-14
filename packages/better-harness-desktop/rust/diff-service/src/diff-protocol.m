// ABI metadata only: every listener, service and bridge behaviour is Rust.
#import <Foundation/Foundation.h>

@protocol HarnessDiffHostProtocol
- (void)sendFrame:(NSData *)frame;
@end

@protocol HarnessDiffClientProtocol
- (void)deliverFrame:(NSData *)frame;
- (void)hostFailed:(NSString *)reason;
@end

Protocol *harness_diff_host_protocol(void) { return @protocol(HarnessDiffHostProtocol); }
Protocol *harness_diff_client_protocol(void) { return @protocol(HarnessDiffClientProtocol); }
