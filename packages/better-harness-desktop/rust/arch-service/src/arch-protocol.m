// ABI metadata only: every listener, service and bridge behaviour is Rust.
#import <Foundation/Foundation.h>

@protocol HarnessArchHostProtocol
- (void)sendFrame:(NSData *)frame;
@end

@protocol HarnessArchClientProtocol
- (void)deliverFrame:(NSData *)frame;
- (void)hostFailed:(NSString *)reason;
@end

Protocol *harness_arch_host_protocol(void) { return @protocol(HarnessArchHostProtocol); }
Protocol *harness_arch_client_protocol(void) { return @protocol(HarnessArchClientProtocol); }
