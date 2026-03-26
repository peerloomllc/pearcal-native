/**
 * RCTThirdPartyComponentsFix.m
 *
 * Under Xcode 26 / iOS 26 SDK, some third-party Fabric component view classes
 * (RNCWebView, RNCSafeAreaProviderComponentView, etc.) are not present in the
 * binary at the time RCTThirdPartyComponentsProvider builds its component map.
 * The generated +thirdPartyFabricComponents uses an NSDictionary literal that
 * throws NSInvalidArgumentException on nil values, crashing at launch.
 *
 * This replaces the method with a nil-safe version that skips missing classes.
 */

#import <Foundation/Foundation.h>
#import <objc/runtime.h>

static NSDictionary *nilSafeThirdPartyFabricComponents(id self, SEL _cmd) {
  static NSDictionary *components = nil;
  static dispatch_once_t token;
  dispatch_once(&token, ^{
    NSMutableDictionary *dict = [NSMutableDictionary dictionary];
    NSArray *entries = @[
      @[@"RNCSafeAreaProvider",          @"RNCSafeAreaProviderComponentView"],
      @[@"RNCSafeAreaView",              @"RNCSafeAreaViewComponentView"],
      @[@"RNCWebView",                   @"RNCWebView"],
      @[@"RNSFullWindowOverlay",         @"RNSFullWindowOverlay"],
      @[@"RNSModalScreen",               @"RNSModalScreen"],
      @[@"RNSScreenContainer",           @"RNSScreenContainerView"],
      @[@"RNSScreenContentWrapper",      @"RNSScreenContentWrapper"],
      @[@"RNSScreenFooter",              @"RNSScreenFooter"],
      @[@"RNSScreen",                    @"RNSScreenView"],
      @[@"RNSScreenNavigationContainer", @"RNSScreenNavigationContainerView"],
      @[@"RNSScreenStackHeaderConfig",   @"RNSScreenStackHeaderConfig"],
      @[@"RNSScreenStackHeaderSubview",  @"RNSScreenStackHeaderSubview"],
      @[@"RNSScreenStack",               @"RNSScreenStackView"],
      @[@"RNSSearchBar",                 @"RNSSearchBar"],
      @[@"RNSStackScreen",               @"RNSStackScreenComponentView"],
      @[@"RNSStackHost",                 @"RNSStackHostComponentView"],
      @[@"RNSBottomTabsScreen",          @"RNSBottomTabsScreenComponentView"],
      @[@"RNSBottomTabs",                @"RNSBottomTabsHostComponentView"],
      @[@"RNSBottomTabsAccessory",       @"RNSBottomTabsAccessoryComponentView"],
      @[@"RNSBottomTabsAccessoryContent",@"RNSBottomTabsAccessoryContentComponentView"],
      @[@"RNSSplitViewHost",             @"RNSSplitViewHostComponentView"],
      @[@"RNSSplitViewScreen",           @"RNSSplitViewScreenComponentView"],
      @[@"RNSSafeAreaView",              @"RNSSafeAreaViewComponentView"],
    ];
    for (NSArray *entry in entries) {
      Class cls = NSClassFromString(entry[1]);
      if (cls) [dict setObject:cls forKey:entry[0]];
    }
    components = [dict copy];
  });
  return components;
}

@interface NSObject (RCTThirdPartyFix)
@end

@implementation NSObject (RCTThirdPartyFix)
+ (void)load {
  Class cls = NSClassFromString(@"RCTThirdPartyComponentsProvider");
  if (cls) {
    Class metaCls = object_getClass(cls);
    SEL sel = @selector(thirdPartyFabricComponents);
    class_replaceMethod(metaCls, sel, (IMP)nilSafeThirdPartyFabricComponents, "@@:");
  }
}
@end
