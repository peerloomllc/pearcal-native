#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(PearCalShare, NSObject)
RCT_EXTERN_METHOD(share:(NSString *)title text:(NSString *)text)
RCT_EXTERN_METHOD(shareCalendar:(NSString *)content)
@end
